---
status: superseded by ADR-0038
---

# Use explicit operation labels

PullOps uses explicit Operation Labels for each requested operation and separate Status Labels for progress state. This superseded decision kept `pullops:implement` overloaded for both Concrete Issues and Parent Issues, inferring parent behavior from native GitHub child issues so humans did not need a separate parent command label.

ADR-0038 supersedes the overloaded `pullops:implement` decision by splitting parent setup, concrete issue implementation, and future parent/child coordination into `pullops:prepare`, `pullops:implement`, and `pullops:coordinate`.
