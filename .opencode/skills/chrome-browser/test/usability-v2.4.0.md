# v2.4.0 sequential usability pass

## Scope and method

Ran the published v2.4.0 CLI and extension interactively through OpenCode in the existing Chrome session on Windows (Node 24.13.0). A harmless loopback fixture supplied deterministic controls and synthetic form values. Only the fixture was extended; browser implementation files remained at release commit `8bcc0f0`.

Each CLI invocation was recorded with its arguments, exit code, response, stdout size, and elapsed process time. The final journal was checked programmatically against the expected visible details, stale-ref error/recovery, and exact form summary.

Times below are **summed CLI execution times**, including process startup and bridge/browser execution. They exclude agent reasoning, tool transport, and discussion time. This is one local run with an already-connected bridge, not a general speed or model-token benchmark. It is a guided current-session pass, not an unattended fresh-agent evaluation.

## Results

| Scenario | Result | Commands | CLI time | Stdout bytes | Expected errors | Screenshots | Extra user intervention |
|---|---|---:|---:|---:|---:|---:|---:|
| Normal browsing | Passed | 5 | 780 ms | 1,669 | 0 | 0 | 0 |
| Reload/stale-ref recovery | Passed | 5 | 1,010 ms | 1,718 | 1 | 0 | 0 |
| Multi-field form | Passed | 8 | 1,146 ms | 6,367 | 0 | 0 | 0 |
| **Total** | **All passed** | **18** | **2,936 ms** | **9,754** | **1 intentional** | **0** | **0** |

Fixture-tab opening was setup: one additional command, 915 ms, 324 bytes. Preflight status and starting the local fixture server were outside the measured scenarios. No measured response was truncated. No blind retries or unintended submissions occurred.

### 1. Normal browsing

1. Find the uniquely marked fixture tab with filtered `tabs list`.
2. Explicitly select that numeric tab ID.
3. Discover the exact `Reveal details` button by role/name.
4. Click its returned ref; response reported `trusted: true`.
5. Wait for the details element to become visible; returned text was `Details are visible`.

Explicit selection is included in this workflow even though opening the fixture had already selected it.

### 2. Recovery

1. Reload the fixture.
2. Deliberately attempt the prior button ref once; receive `stale`, exit 1, and a fresh-discovery hint.
3. Rediscover the same button and receive a new epoch ref.
4. Click the new ref successfully.
5. Verify visible details.

The failure was intentional. The old ref was not retried after the error. This scenario covered page reload and stale refs, not tab closure or an interrupted mutation.

### 3. Form interaction before submission

1. Discover controls in frame 0.
2. Inspect Topic to read available option labels.
3. Fill Full name: `Ada Example`.
4. Fill Email address: `ada@example.test`.
5. Fill Notes: `Checking the published skill.`
6. Select Topic: `Testing`.
7. Check Receive reminders.
8. Inspect the fixture's live state output and compare its JSON with the requested values.

Final state matched all values, with `topic: "testing"`, `reminders: true`, and **`submissions: 0`**. The submit button was never activated. Verification used the fixture's rendered state summary; real applications may not offer an equivalent summary.

## Observed friction and next priorities

1. **Form-scoped discovery.** The first form observation returned 17 entries to locate five editable/selectable controls plus the verification output. Unrelated buttons and duplicate label entries accounted for avoidable output. This discovery response alone was 3,269 bytes—about half the form scenario's output.
2. **Privacy-preserving field assertions.** A command that verifies an expected field value/state and returns match/mismatch could verify real forms without needing a site-specific rendered summary or exposing field values by default.
3. **Broader application coverage after these improvements.** Repeat on a reactive form and an iframe form to test rerenders and focus transitions. No evidence from this single fixture establishes reliability for those cases yet.

No implementation defect requiring an immediate v2.4.1 fix was reproduced in these three scenarios. The next update should target scoped observation and verification ergonomics rather than automatic mutation retries.
