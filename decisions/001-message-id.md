# 001. Message identity and ordering

Status: Accepted

Date: 2026-09-23

A message is identified by its device ID, taken from the topic, plus `seq`, a counter the device increases by one for every message it sends. `seq` alone decides order. `ts` is the time the device says the event happened; we store it and show it as last seen, but it never decides which message wins. If a message arrives with a device ID and `seq` we already have, it is ignored without error. If its `seq` is lower than the device's current state, it is saved to event history but does not change current state.

Server-assigned IDs and server receive time both fail on reconnect. A device replaying twenty buffered messages delivers them within milliseconds, so receive time says nothing about order, and a fresh server ID on each copy makes duplicates impossible to spot. Device timestamps are not safe for ordering either, since device clocks drift and reset. This decision assumes `seq` survives a reboot. A device that is factory reset and starts over at 1 would have its new messages treated as stale; fixing that needs a boot counter in the message and is out of scope for now. In Mongo, events get a unique index on device ID and `seq`, so the same device ID and seq can never be stored twice, enforced by the database rather than a check in code, and the current state update only applies when the incoming `seq` is higher than the stored one.
