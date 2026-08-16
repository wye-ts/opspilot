"""three_state_check_status

Migrates evaluation_checks from the v1 two-state boolean (passed) to the v2
three-state status domain ('PASS' | 'FAIL' | 'NOT_APPLICABLE') that the
active service writes (OpsPilot #59 Checkpoint A §3/§7).

Upgrade is non-lossy for v1 data: historical `passed` booleans map to
PASS/FAIL, and the new NOT_APPLICABLE state simply does not exist in v1 rows.
Downgrade is LOSSY: v2 NOT_APPLICABLE rows have no v1 boolean counterpart, so
they are deleted, and every remaining non-FAIL status maps back to
passed = TRUE (see downgrade()).

Revision ID: 04098efaef34
Revises: 01d97cae4df6
Create Date: 2026-08-15 22:27:45.441328

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '04098efaef34'
down_revision: Union[str, None] = '01d97cae4df6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Add the v2 three-state status column (nullable initially so the
    #    backfill below can populate it).
    op.add_column("evaluation_checks", sa.Column("status", sa.String(length=16), nullable=True))

    # 2. Backfill from the historical boolean: a passing check becomes PASS,
    #    everything else FAIL (NOT_APPLICABLE did not exist in v1).
    op.execute(
        sa.text(
            "UPDATE evaluation_checks SET status = CASE WHEN passed IS TRUE THEN 'PASS' ELSE 'FAIL' END"
        )
    )

    # 3. Make status NOT NULL — every row is now populated.
    op.alter_column("evaluation_checks", "status", existing_type=sa.String(length=16), nullable=False)

    # 4. Drop the old v1 two-state invariant; it references the superseded
    #    `passed` boolean and must go before that column is dropped.
    op.drop_constraint("ck_checks_passed_reason_code", "evaluation_checks", type_="check")

    # 5. Add the v2 three-state domain constraint plus the status/reason_code
    #    invariant mirroring EvaluationCheckV2: a PASS check carries no
    #    reason_code; a FAIL/NOT_APPLICABLE check must.
    op.create_check_constraint(
        "ck_checks_status_domain",
        "evaluation_checks",
        "status IN ('PASS', 'FAIL', 'NOT_APPLICABLE')",
    )
    op.create_check_constraint(
        "ck_checks_status_reason_code",
        "evaluation_checks",
        "(status = 'PASS' AND reason_code IS NULL)"
        " OR (status IN ('FAIL', 'NOT_APPLICABLE') AND reason_code IS NOT NULL)",
    )

    # 6. Drop the superseded boolean.
    op.drop_column("evaluation_checks", "passed")


def downgrade() -> None:
    # LOSSY: the v2 NOT_APPLICABLE state has no v1 boolean counterpart.
    # NOT_APPLICABLE rows are deleted; every remaining non-FAIL status maps
    # back to passed = TRUE.
    op.add_column("evaluation_checks", sa.Column("passed", sa.Boolean(), nullable=True))
    op.execute(sa.text("DELETE FROM evaluation_checks WHERE status = 'NOT_APPLICABLE'"))
    op.execute(sa.text("UPDATE evaluation_checks SET passed = (status != 'FAIL')"))
    op.alter_column("evaluation_checks", "passed", existing_type=sa.Boolean(), nullable=False)

    # Swap the v2 constraints back for the historical v1 invariant, then drop
    # the status column (its data has already been folded into `passed`).
    op.drop_constraint("ck_checks_status_reason_code", "evaluation_checks", type_="check")
    op.drop_constraint("ck_checks_status_domain", "evaluation_checks", type_="check")
    op.create_check_constraint(
        "ck_checks_passed_reason_code",
        "evaluation_checks",
        "(passed IS TRUE AND reason_code IS NULL) OR (passed IS FALSE AND reason_code IS NOT NULL)",
    )
    op.drop_column("evaluation_checks", "status")
