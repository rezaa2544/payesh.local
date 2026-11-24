# LAB-176: replays the run-steps of .github/workflows/native-client.yml Linux jobs that need a REAL
# server / Gateway / PostgreSQL VERBATIM (same env + run + working-directory) against local PG17
# (CI: postgres:16 service). Skips only: npm ci, the Flutter download step (pinned Flutter already present).
# $GITHUB_WORKSPACE -> ~/lab176/raw/ci-out (artifacts land in evidence). One NI-xx log per step.
import yaml, subprocess, os, shlex, sys
R='/work/repo'; OUT=os.path.expanduser('~/lab176/raw/ci-out'); os.makedirs(OUT+'/owner-out', exist_ok=True)
w=yaml.safe_load(open(R+'/.github/workflows/native-client.yml'))
jobs=sys.argv[1:] or ['gate-controls','engine-web-conformance','sync-real-server','gateway-real','owner-native-it']
subprocess.run("psql -h 127.0.0.1 -U postgres -c 'drop database if exists payesh_gw75' -c 'create database payesh_gw75'", shell=True)
i=0
for jk in jobs:
    j=w['jobs'][jk]; base_env=dict(w.get('env') or {}); base_env.update(j.get('env') or {})
    wd_default=((j.get('defaults') or {}).get('run') or {}).get('working-directory')
    for st in j['steps']:
        run=st.get('run'); name=st.get('name', (run or '').split('\n')[0])[:100]
        if not run or run.strip()=='npm ci' or 'storage.googleapis.com/flutter_infra_release' in run: continue
        i+=1; env=dict(base_env); env.update(st.get('env') or {}); env['GITHUB_WORKSPACE']=OUT
        wd=st.get('working-directory') or wd_default or '.'
        exports=''.join(f"export {k}={shlex.quote(str(v))}\n" for k,v in env.items() if '${{' not in str(v))
        script=f"/tmp/ni-step-{i:02d}.sh"
        open(script,'w').write("set -e\n"+exports+f"cd {shlex.quote(os.path.join(R,wd))}\n"+run.replace('${{ github.workspace }}',OUT))
        tid=f"NI-{i:02d}"
        subprocess.run(['bash',os.path.expanduser('~/lab176/scripts/run-t.sh'),tid,f"CI native-client/{jk} step: {name}",'--',f"bash {script}"])
        with open(os.path.expanduser('~/lab176/raw/NI-INDEX.txt'),'a') as f: f.write(f"{tid}\t{jk}\t{name}\n")
print('CI-NATIVE-IT-DONE')
