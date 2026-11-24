#!/bin/bash
# LAB-176: sequential, nothing else heavy alongside. (1) native-client real-server IT jobs (never run before in this lab)
# (2) post-fix regression for D-04/D-05: npm test, identity-65 (+mutants), api-contract native-contract on PG17.
cd /work/repo; T=$HOME/lab176/scripts/run-t.sh
python3 $HOME/lab176/scripts/ci-native-it.py >> $HOME/lab176/raw/SUMMARY.txt 2>&1
$T REG-02-npm-test-postfix "npm test after D-04/D-05 fix" -- "npm test"
$T ID65-postfix "tests/identity-65.js (+mutants) after D-04/D-05 fix" -- "node --experimental-sqlite --disable-warning=ExperimentalWarning tests/identity-65.js"
python3 $HOME/lab176/scripts/ci-pg-suite-postfix.py >> $HOME/lab176/raw/SUMMARY.txt 2>&1
echo POSTFIX-DONE >> $HOME/lab176/raw/SUMMARY.txt
