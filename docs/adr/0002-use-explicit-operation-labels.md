---
status: superseded by ADR-0039
---

# Use explicit operation labels

PullOps uses explicit Operation Labels for each requested operation and separate Status Labels for progress state. This superseded decision kept `pullops:implement` overloaded for both Concrete Issues and Parent Issues, inferring parent behavior from native GitHub child issues so humans did not need a separate parent command label.

ADR-0038 superseded the overloaded `pullops:implement` decision by splitting parent setup, concrete issue implementation, and future parent/child coordination into separate flat labels.

ADR-0039 supersedes the flat Operation Label vocabulary with target-kind namespaces such as `pullops:prd:prepare`, `pullops:issue:implement`, and `pullops:pr:review`.
