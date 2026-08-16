"""The closed NotApplicableCode set, mirrored from the TypeScript source of
truth: apps/worker/src/evaluation/not-applicable-codes.ts.

The three application-authored reasons a v2 check can be structurally
NOT_APPLICABLE for (see schemas.py's EvaluationCheckV2). At Checkpoint A the
active scorer emits PASS/FAIL only — this vocabulary is the structural
support the v2 contract requires so a future check can declare a
case/situation inapplicable without inventing a metric-specific reason code
(those belong to Issue #59 Checkpoint B).

CLI prose mapping (NOT_APPLICABLE_MESSAGES in the TS file) stays a
TypeScript concern — this module carries only the wire-facing codes,
mirroring scoring/reason_codes.py.
"""

from __future__ import annotations

from enum import StrEnum


class NotApplicableCode(StrEnum):
    NA_RUN_DID_NOT_COMPLETE = "NA_RUN_DID_NOT_COMPLETE"
    NA_EXPECTATION_NOT_DECLARED = "NA_EXPECTATION_NOT_DECLARED"
    NA_NO_RECOVERY_PATH_EXERCISED = "NA_NO_RECOVERY_PATH_EXERCISED"
