"""Offline local setup only. Never imports the Snowflake SDK or opens a network connection."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import re
import tempfile
try:
    import tomllib
except ModuleNotFoundError:
    # The managed reader already requires 3.11+. Report that dependency without
    # a traceback, configuration contents or an attempted sign-in.
    if __name__ == '__main__':
        print(json.dumps({'state': 'runtime_unsupported', 'code': 'PYTHON_VERSION_UNSUPPORTED'}))
        raise SystemExit(1)
    raise

FIELDS = {'schema_version', 'connection_name', 'account', 'authenticator', 'role', 'warehouse'}
SAFE_CODES = {'CONFIG_UNSAFE', 'CONFIG_INVALID', 'SETUP_TEMPLATE_MISSING', 'SETUP_TEMPLATE_INVALID', 'LOGIN_HINT_MISSING',
              'PACKAGE_MISMATCH', 'SHARED_CONFIGURATION_REVIEW_REQUIRED', 'CONFIG_CHANGED_DURING_SETUP'}

def validate_template(value, connection_name, approved_roles):
    if (not isinstance(value, dict) or set(value) != FIELDS or value.get('schema_version') != '1.0'
        or value.get('connection_name') != connection_name or value.get('authenticator') != 'externalbrowser'
        or value.get('role') not in approved_roles
        or not all(isinstance(value.get(key), str) and re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}', value[key]) for key in ('account', 'role', 'warehouse'))):
        raise ValueError('SETUP_TEMPLATE_INVALID')
    return value

def read_config(config):
    if config.is_symlink() or config.parent.is_symlink(): raise ValueError('CONFIG_UNSAFE')
    if not config.exists(): return b'', {}
    info = config.stat()
    if not config.is_file() or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 1048576: raise ValueError('CONFIG_UNSAFE')
    try:
        raw = config.read_bytes()
        return raw, tomllib.loads(raw.decode('utf-8'))
    except (ValueError, UnicodeError): raise ValueError('CONFIG_INVALID') from None

def inspect(config, connection_name):
    if (config.parent / 'connections.toml').exists(): raise ValueError('SHARED_CONFIGURATION_REVIEW_REQUIRED')
    raw, data = read_config(config)
    if not config.exists(): return {'state': 'configuration_missing'}
    parameters = data.get('connections', {}).get(connection_name)
    if not isinstance(parameters, dict): return {'state': 'connection_missing'}
    if not all(isinstance(parameters.get(key), str) and parameters[key].strip() for key in ('account', 'authenticator', 'user', 'role', 'warehouse')) or parameters['authenticator'].lower() != 'externalbrowser':
        return {'state': 'configuration_incomplete', 'code': 'CONFIG_INCOMPLETE'}
    return {'state': 'configured'}

def configure(config, connection_name, template_path, descriptor_path, package_version, approved_roles):
    state = inspect(config, connection_name)
    if state['state'] in ('configured', 'configuration_incomplete'): return {**state, 'changed': False}
    if not template_path.is_file() or template_path.is_symlink(): raise ValueError('SETUP_TEMPLATE_MISSING')
    try: template = validate_template(json.loads(template_path.read_text()), connection_name, approved_roles)
    except (OSError, json.JSONDecodeError): raise ValueError('SETUP_TEMPLATE_INVALID') from None
    try: descriptor = json.loads(descriptor_path.read_text())
    except (OSError, json.JSONDecodeError): raise ValueError('LOGIN_HINT_MISSING') from None
    if descriptor.get('package_version') != package_version: raise ValueError('PACKAGE_MISMATCH')
    # This is an SSO login hint, never proof of identity or data access.
    login_hint = descriptor.get('handoff_scope', {}).get('named_tester')
    if not isinstance(login_hint, str) or not re.fullmatch(r'[A-Za-z0-9.!#$%&\'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', login_hint): raise ValueError('LOGIN_HINT_MISSING')
    original, parsed = read_config(config)
    parameters = {key: template[key] for key in ('account', 'authenticator', 'role', 'warehouse')}
    parameters['user'] = login_hint
    block = '\n[connections.' + json.dumps(connection_name) + ']\n' + ''.join(key + ' = ' + json.dumps(value) + '\n' for key, value in parameters.items())
    if 'logs' not in parsed.get('cli', {}): block += '\n[cli.logs]\nsave_logs = false\n'
    updated = original + (b'\n' if original and not original.endswith(b'\n') else b'') + block.encode('utf-8')
    try:
        verified = tomllib.loads(updated.decode('utf-8'))
        if verified['connections'][connection_name] != parameters: raise ValueError('CONFIG_INVALID')
    except (ValueError, KeyError, TypeError): raise ValueError('CONFIG_INVALID') from None
    config.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if config.parent.is_symlink() or config.parent.stat().st_uid != os.getuid() or config.parent.stat().st_mode & 0o022: raise ValueError('CONFIG_UNSAFE')
    temporary = None
    try:
        descriptor_fd, temporary = tempfile.mkstemp(prefix='.copilot-snowflake-', dir=config.parent)
        with os.fdopen(descriptor_fd, 'wb') as output: output.write(updated)
        if read_config(config)[0] != original: raise ValueError('CONFIG_CHANGED_DURING_SETUP')
        # Use an exclusive link for a new file so a concurrent setup is never overwritten.
        if not config.exists():
            try: os.link(temporary, config)
            except FileExistsError: raise ValueError('CONFIG_CHANGED_DURING_SETUP') from None
        else: os.replace(temporary, config)
        return {'state': 'configured', 'changed': True}
    finally:
        if temporary is not None and os.path.exists(temporary): os.unlink(temporary)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config-path', required=True); parser.add_argument('--connection-name', required=True)
    parser.add_argument('--configure', action='store_true'); parser.add_argument('--template-path'); parser.add_argument('--descriptor-path')
    parser.add_argument('--package-version'); parser.add_argument('--approved-roles', default='[]')
    args = parser.parse_args()
    try:
        config = Path(args.config_path)
        result = configure(config, args.connection_name, Path(args.template_path), Path(args.descriptor_path), args.package_version, json.loads(args.approved_roles)) if args.configure else inspect(config, args.connection_name)
        print(json.dumps(result)); return 0
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and str(error) in SAFE_CODES else 'LOCAL_SETUP_CHECK_FAILED'
        print(json.dumps({'state': 'blocked', 'code': code})); return 1

if __name__ == '__main__': raise SystemExit(main())
