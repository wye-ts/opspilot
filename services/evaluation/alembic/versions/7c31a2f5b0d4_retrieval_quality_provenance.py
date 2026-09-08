"""retrieval_quality_provenance

Adds Milestone 13 Issue B (#75) retrieval-quality provenance to
evaluation_runs: which retriever a run's precomputed retrieval-quality metrics
came from, and the content hash of the corpus they were scored against.

Both columns are nullable and both are NULL for every pre-existing row — no
backfill is possible or needed, since no prior run could have had these values.
The application invariant (both set together or neither; a row with exactly one
fails closed via INTERNAL_ERROR on read) is enforced in
api._read_provenance rather than as a CHECK constraint, matching how the
service already handles partial metric-generation shapes in _read_metrics.

Downgrade is non-lossy for pre-#75 data and drops only the two new columns.

Revision ID: 7c31a2f5b0d4
Revises: 04098efaef34
Create Date: 2026-09-08 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '7c31a2f5b0d4'
down_revision: Union[str, None] = '04098efaef34'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "evaluation_runs",
        sa.Column("retrieval_quality_retriever_name", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "evaluation_runs",
        sa.Column("retrieval_quality_corpus_hash", sa.String(length=128), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("evaluation_runs", "retrieval_quality_corpus_hash")
    op.drop_column("evaluation_runs", "retrieval_quality_retriever_name")
