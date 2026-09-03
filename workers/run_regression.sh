#!/usr/bin/env bash
set -u
cd "E:/D盘备份/miniprogram/workers" || exit 1
BASE=http://127.0.0.1:8797

run() {
  local name="$1" fix="$2" file="$3"
  echo "######## $name (fixture=$fix) ########"
  node tests/fixture.mjs "$fix" >/dev/null 2>&1
  BASE_URL="$BASE" node "tests/$file" >"/tmp/$name.out" 2>&1
  local ec=$?
  local fc
  fc=$(grep -cE "FAIL" "/tmp/$name.out")
  echo "$name exit=$ec FAIL-count=$fc"
  grep -E "=====.*pass=|结果|TOTAL" "/tmp/$name.out" | tail -2
  node tests/fixture.mjs teardown >/dev/null 2>&1
}

echo "######## S2-4 validate_local_d1 (clean) ########"
node tests/fixture.mjs teardown >/dev/null 2>&1
node --experimental-sqlite scripts/validate_local_d1.mjs 2>&1 | grep -vE "ExperimentalWarning|trace-warnings" | tail -4

run S2-5 setup api_integration.mjs
run S2-6c-1 session session_integration.mjs
run S2-6c-2 auth auth_integration.mjs
run S2-6c-3 firstlogin firstlogin_integration.mjs
run S2-6c-4 sec session_security_integration.mjs
run S2-6f authz authorization_integration.mjs
run S2-6g signup activity_signup_integration.mjs
run S2-6h attendance attendance_integration.mjs
echo "ALL REGRESSION DONE"
