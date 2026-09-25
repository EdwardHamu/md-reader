#!/usr/bin/env bash
# Offline integration tests: fake gh/notifications, real Bash + GNU timeout.
set -Eeuo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source "$root/scripts/release-win.sh"
[[ $(urlencode 'feature/中文') == 'feature%2F%E4%B8%AD%E6%96%87' ]]
[[ $(urlencode 'main') == main ]]
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/bin"
cat > "$tmp/bin/powershell.exe" <<'MOCK'
#!/usr/bin/env bash
printf '%s | %s\n' "$RELEASE_WIN_NOTIFY_TITLE" "$RELEASE_WIN_NOTIFY_BODY" >> "$MOCK_STATE/notifications"
MOCK
cat > "$tmp/bin/gh" <<'MOCK'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$MOCK_STATE/calls"
case "$1 $2" in
  'run list')
    if [[ -f $MOCK_STATE/dispatched ]]; then echo 987; fi ;;
  'workflow run')
    echo yes >> "$MOCK_STATE/dispatched"
    if [[ $SCENARIO == ambiguous ]]; then echo 'lost response' >&2; exit 1; fi ;;
  'api repos/demo/reader/commits/main') printf '%040d\n' 1 ;;
  'api repos/demo/reader/actions/workflows/release-win.yml') echo active ;;
  'api repos/demo/reader/contents/package.json?ref=0000000000000000000000000000000000000001') echo 0.3.10 ;;
  'api repos/demo/reader/git/matching-refs/tags/v0.3.10-win.')
    printf '%s\n' refs/tags/v0.3.10-win.1 refs/tags/v0.3.10-win.3 refs/tags/v0.3.10-win.x ;;
  'api repos/demo/reader/releases?per_page=100') printf '%s\n' v0.3.9 v0.3.10-win.4 v0.3.10 ;;
  'release download')
    printf '%s\n' "$*" >> "$MOCK_STATE/downloads"
    if [[ $SCENARIO == dlfail ]]; then echo 'HTTP 404' >&2; exit 1; fi
    dir=''; prev=''
    for a in "$@"; do [[ $prev == --dir ]] && dir=$a; prev=$a; done
    mkdir -p "$dir"; : > "$dir/MD Reader_0.3.10_x64-setup.exe" ;;
  'api repos/demo/reader/actions/runs/987')
    n=0; [[ ! -f $MOCK_STATE/polls ]] || n=$(cat "$MOCK_STATE/polls")
    n=$((n+1)); echo "$n" > "$MOCK_STATE/polls"
    status=completed; result=success; path=.github/workflows/release-win.yml
    case "$SCENARIO" in
      failure) result=failure ;;
      cancelled) result=cancelled ;;
      wrong) path=.github/workflows/other.yml ;;
      timeout) status=in_progress; result=pending ;;
      queued) if ((n == 1)); then status=queued; result=pending; elif ((n == 2)); then status=in_progress; result=pending; fi ;;
      retry) if ((n <= 2)); then echo 'PARTIAL INVALID JSON'; echo '503 temporary failure' >&2; exit 1; fi ;;
    esac
    printf '%s\t%s\thttps://github.com/demo/reader/actions/runs/987\t%s\tworkflow_dispatch\n' "$status" "$result" "$path" ;;
  *) echo "Unexpected mock command: $*" >&2; exit 1 ;;
esac
MOCK
cat > "$tmp/bin/git" <<'MOCK'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$MOCK_STATE/git-calls"
case "$1" in
  status) if [[ $SCENARIO == dirty ]]; then echo ' M src/App.vue'; fi ;;
  symbolic-ref) echo main ;;
  rev-parse) printf '%040d\n' 1 ;;
  remote)
    case "$SCENARIO" in
      wrongrepo) echo https://github.com/other/reader.git ;;
      multiurl) printf '%s\n' https://github.com/demo/reader.git https://github.com/other/reader.git ;;
      *) echo https://github.com/demo/reader.git ;;
    esac ;;
  -c)
    [[ $* == '-c push.followTags=false -c push.recurseSubmodules=no push --porcelain -- https://github.com/demo/reader.git 0000000000000000000000000000000000000001:refs/heads/main' ]] || exit 99
    n=0; [[ ! -f $MOCK_STATE/push-count ]] || n=$(cat "$MOCK_STATE/push-count")
    n=$((n+1)); echo "$n" > "$MOCK_STATE/push-count"
    if [[ $SCENARIO == pushretry && $n == 1 ]]; then echo 'PARTIAL PUSH'; exit 1; fi
    if [[ $SCENARIO == pushreject ]]; then echo 'non-fast-forward' >&2; exit 1; fi
    echo 'push OK' ;;
  *) echo "Unexpected git command: $*" >&2; exit 99 ;;
esac
MOCK
chmod +x "$tmp/bin/git"
chmod +x "$tmp/bin/gh" "$tmp/bin/powershell.exe"
run_case() {
  local scenario=$1 expected=$2 rc count; shift 2
  mkdir -p "$tmp/$scenario"
  # Run inside the case dir so default relative downloads never touch the repo.
  if (cd "$tmp/$scenario" && env PATH="$tmp/bin:$PATH" MOCK_STATE="$tmp/$scenario" SCENARIO="$scenario" \
    RETRY_ATTEMPTS=3 RETRY_DELAY_SECONDS=1 POLL_INTERVAL_SECONDS=1 \
    REQUEST_TIMEOUT_SECONDS=5 DISCOVERY_TIMEOUT_SECONDS=5 MONITOR_TIMEOUT_SECONDS=10 \
    bash "$root/scripts/release-win.sh" --repo demo/reader "$@" >"$tmp/$scenario/log" 2>&1); then rc=0; else rc=$?; fi
  if [[ $rc != "$expected" ]]; then cat "$tmp/$scenario/log"; echo "FAIL $scenario: $rc != $expected"; exit 1; fi
  count=$(wc -l < "$tmp/$scenario/notifications")
  [[ $count -eq 1 ]] || { echo "FAIL $scenario: expected one notification"; exit 1; }
  echo "PASS $scenario (exit $rc, one notification)"
}
run_case success 0 --run-id 987
run_case queued 0 --run-id 987
run_case retry 0 --run-id 987
grep -q '打包成功' "$tmp/retry/notifications"
! grep -q 'PARTIAL INVALID JSON' "$tmp/retry/log"
run_case failure 1 --run-id 987
run_case cancelled 2 --run-id 987
run_case wrong 1 --run-id 987
run_case dispatch 0 --tag v0.3.10-win.1 --ref main --allow-remote
run_case ambiguous 0 --tag v0.3.10-win.1 --ref main --allow-remote
[[ $(wc -l < "$tmp/ambiguous/dispatched") -eq 1 ]]
[[ $(wc -l < "$tmp/dispatch/dispatched") -eq 1 ]]
# Resume by correlation ID must not dispatch again.
mkdir -p "$tmp/resume"; touch "$tmp/resume/dispatched"
run_case resume 0 --request-id existing-request
! grep -q '^workflow run' "$tmp/resume/calls"
run_case timeout 124 --run-id 987
grep -q '超时' "$tmp/timeout/notifications"
! grep -q 'run cancel' "$tmp/timeout/calls"
run_case push 0 --ref main --tag v0.3.10-win.1
[[ $(cat "$tmp/push/push-count") -eq 1 ]]
run_case pushretry 0 --ref main --tag v0.3.10-win.1
[[ $(cat "$tmp/pushretry/push-count") -eq 2 ]]
! grep -q 'PARTIAL PUSH' "$tmp/pushretry/log"
run_case dirty 1 --ref main --tag v0.3.10-win.1
run_case wrongrepo 1 --ref main --tag v0.3.10-win.1
run_case multiurl 1 --ref main --tag v0.3.10-win.1
run_case otherbranch 1 --ref other --tag v0.3.10-win.1
run_case pushreject 1 --ref main --tag v0.3.10-win.1
for scenario in dirty wrongrepo multiurl otherbranch; do
  [[ ! -f $tmp/$scenario/push-count && ! -f $tmp/$scenario/dispatched ]]
done
[[ ! -f $tmp/pushreject/dispatched ]]
# Remote-only and monitor/resume modes must not even call Git.
for scenario in dispatch resume success; do [[ ! -f $tmp/$scenario/git-calls ]]; done
# Auto tag: max(win.1, win.3, release win.4) + 1 = win.5; exe downloaded to the default dir.
run_case autotag 0 --ref main --allow-remote
grep -q 'release_tag=v0.3.10-win.5' "$tmp/autotag/calls"
grep -q '^release download v0.3.10-win.5 --repo demo/reader --pattern \*.exe --dir release-downloads/v0.3.10-win.5 --clobber$' "$tmp/autotag/downloads"
grep -q 'EXE 已下载' "$tmp/autotag/notifications"
[[ -f "$tmp/autotag/release-downloads/v0.3.10-win.5/MD Reader_0.3.10_x64-setup.exe" ]]
# Custom download dir and opt-out.
run_case dldir 0 --run-id 987 --tag v0.3.10-win.1 --download-dir "$tmp/dl"
[[ -f "$tmp/dl/MD Reader_0.3.10_x64-setup.exe" ]]
run_case nodl 0 --run-id 987 --tag v0.3.10-win.1 --no-download
[[ ! -f $tmp/nodl/downloads ]]
# Build succeeded but download failed: exit 3, still exactly one notification.
run_case dlfail 3 --run-id 987 --tag v0.3.10-win.1 --download-dir "$tmp/dlfail-out"
grep -q '下载失败' "$tmp/dlfail/notifications"
# Monitoring without a tag cannot know which release to download.
[[ ! -f $tmp/success/downloads ]]
echo 'All 21 offline release-win tests passed. No real push, GitHub request or popup was made.'
