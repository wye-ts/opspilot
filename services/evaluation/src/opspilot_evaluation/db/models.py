"""SQLAlchemy 2.x async ORM models for the Python-owned evaluation tables.

This is the sole owner of these tables — never added to Prisma (see the task
spec, "Persistence"). Four tables:
  - evaluation_runs         one row per POST /evaluations call
  - evaluation_case_results one row per case, with expectations/observed JSONB
  - evaluation_checks       one row per emitted check, stable ordering via check_index
  - evaluation_metrics      one row per of the six aggregate metrics, PK (evaluation_run_id, name)
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class EvaluationRun(Base):
    __tablename__ = "evaluation_runs"

    id: Mapped[uuid.UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    contract_version: Mapped[int] = mapped_column(Integer, nullable=False)
    # Unbounded text, not varchar(255) — the approved plan places no length
    # cap on datasetId at the API boundary (schemas.py's EvaluationSuiteInputV1
    # only requires min_length=1), so persistence must not silently impose one.
    dataset_id: Mapped[str] = mapped_column(Text, nullable=False)
    # No async execution/lifecycle in Phase 2 (scoring happens synchronously
    # in-process before persistence — see "Transaction semantics"), so this
    # is always "COMPLETED" today. Column exists for the result model /
    # future phases rather than to express real state transitions yet.
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="COMPLETED")
    total_cases: Mapped[int] = mapped_column(Integer, nullable=False)
    passed_cases: Mapped[int] = mapped_column(Integer, nullable=False)
    failed_cases: Mapped[int] = mapped_column(Integer, nullable=False)
    pass_rate: Mapped[float] = mapped_column(Float, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    completed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    case_results: Mapped[list[EvaluationCaseResult]] = relationship(
        back_populates="run", cascade="all, delete-orphan", order_by="EvaluationCaseResult.case_index"
    )
    metrics: Mapped[list[EvaluationMetric]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )


class EvaluationCaseResult(Base):
    __tablename__ = "evaluation_case_results"
    __table_args__ = (UniqueConstraint("evaluation_run_id", "case_id", name="uq_case_results_run_case"),)

    id: Mapped[uuid.UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    evaluation_run_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("evaluation_runs.id", ondelete="CASCADE"), nullable=False
    )
    # Preserves suite case order on reload — JSONB row order is not
    # guaranteed to match insertion order once queried.
    case_index: Mapped[int] = mapped_column(Integer, nullable=False)
    case_id: Mapped[str] = mapped_column(String(255), nullable=False)
    passed: Mapped[bool] = mapped_column(Boolean, nullable=False)
    expectations: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    observed: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)

    run: Mapped[EvaluationRun] = relationship(back_populates="case_results")
    checks: Mapped[list[EvaluationCheck]] = relationship(
        back_populates="case_result", cascade="all, delete-orphan", order_by="EvaluationCheck.check_index"
    )


class EvaluationCheck(Base):
    __tablename__ = "evaluation_checks"
    __table_args__ = (
        UniqueConstraint("case_result_id", "check_index", name="uq_checks_case_result_index"),
        CheckConstraint(
            "(passed IS TRUE AND reason_code IS NULL) OR (passed IS FALSE AND reason_code IS NOT NULL)",
            name="ck_checks_passed_reason_code",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    case_result_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("evaluation_case_results.id", ondelete="CASCADE"), nullable=False
    )
    check_index: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    passed: Mapped[bool] = mapped_column(Boolean, nullable=False)
    reason_code: Mapped[str | None] = mapped_column(String(64), nullable=True)

    case_result: Mapped[EvaluationCaseResult] = relationship(back_populates="checks")


class EvaluationMetric(Base):
    __tablename__ = "evaluation_metrics"

    evaluation_run_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("evaluation_runs.id", ondelete="CASCADE"), primary_key=True
    )
    name: Mapped[str] = mapped_column(String(64), primary_key=True)
    numerator: Mapped[int] = mapped_column(Integer, nullable=False)
    denominator: Mapped[int] = mapped_column(Integer, nullable=False)

    run: Mapped[EvaluationRun] = relationship(back_populates="metrics")
