# Runs the steps of .github/workflows/api-contract.yml job native-contract VERBATIM (same env + run)
# against the local PostgreSQL 17 (CI: postgres:16.15 service). One DB-xx log per step via run-t.sh.
import yaml, subprocess, os, shlex, json
w = yaml.safe_load(open('/work/repo/.github/workflows/api-contract.yml'))
steps = w['jobs']['native-contract']['steps']
subprocess.run("psql -h 127.0.0.1 -U postgres -c 'drop database if exists payesh_c64' -c 'create database payesh_c64'", shell=True)
i = 0
for st in steps:
    run = st.get('run')
    if not run or run.strip() == 'npm ci': continue
    i += 1
    name = st.get('name', run.split('\n')[0])[:110]
    env = ' '.join(f"{k}={shlex.quote(str(v))}" for k, v in (st.get('env') or {}).items())
    script = f"/tmp/ci-step-{i:02d}.sh"
    open(script, 'w').write("set -e\n" + (f"export {env}\n" if env else "") + run)
    tid = f"DB-{i:02d}"
    subprocess.run(['bash', os.path.expanduser('~/lab176/scripts/run-t.sh'), tid, f"CI api-contract/native-contract step: {name}", '--', f"bash {script}"])
    with open(os.path.expanduser('~/lab176/raw/DB-INDEX.txt'), 'a') as f: f.write(f"{tid}\t{name}\n")
print('CI-PG-SUITE-DONE')
