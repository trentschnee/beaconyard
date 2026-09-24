# Review log

One line per miss found in review: what was wrong, what caught it, what changed so it won't recur. Hits get logged too.

| Spec | What was wrong                                                                                                                    | What caught it                                                                 | What changed                                                                                                  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| 01   | (hit) Plan escalated the concurrent-insert strategy instead of choosing, per the CLAUDE.md escalate rule                          | Plan review                                                                    | Chose pipeline upsert filtered on deviceId so duplicates never travel an error path                           |
| 01   | Api subscribed once at startup and relied on mqtt.js to resubscribe after reconnects; a comment asserted this, no test covered it | Manual smoke test showed the first subscribe failing, then review of client.ts | Spec now requires subscribe on every connect; unit test with fake client; verified live with a broker restart |
