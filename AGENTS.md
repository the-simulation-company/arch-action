# Releases

Merges into `main` automatically publish through `.github/workflows/latest.yml`. Ensure required backend compatibility is deployed before merging; merging is a release decision.

The workflow tests the current `main` tip on Node 24, publishes the next unused stable patch version, and advances `@latest`. Release tags are the version source; `package.json` is private and is not published to npm. Reruns reuse a stable tag on the tested commit. Rapid merges may share one release containing all their changes.

Automatic releases increment the patch version. Manual stable releases and rollback dispatches retain the existing promotion path. Never move an existing version tag.

After merging, verify workflow success, the stable release tag, and remote `latest` all identify the tested commit and contain the merged change. If a newer merge was included, verify ancestry rather than moving `latest` backward. If publication fails, fix the cause and rerun the workflow; do not create a second release while automation is still running.
