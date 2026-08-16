import { useEffect, useRef, useState } from "react";

import type { SuggestedAction } from "../api/types";
import { humanizeEnum } from "../format/text";

export interface SuggestedActionCardProps {
  readonly action: SuggestedAction;
}

type ChipTone = "neutral" | "info" | "warning" | "danger" | "success";

function priorityTone(priority: string): ChipTone {
  switch (priority) {
    case "LOW":
      return "neutral";
    case "MEDIUM":
      return "warning";
    case "HIGH":
    case "URGENT":
      return "danger";
    default:
      return "neutral";
  }
}

function ticketStatusTone(status: string): ChipTone {
  switch (status) {
    case "OPEN":
      return "neutral";
    case "IN_PROGRESS":
      return "info";
    case "WAITING_ON_CUSTOMER":
      return "warning";
    case "RESOLVED":
      return "success";
    default:
      return "neutral";
  }
}

function Chip({ tone, children }: { readonly tone: ChipTone; readonly children: string }) {
  return <span className={`suggested-action-chip suggested-action-chip--${tone}`}>{children}</span>;
}

// Small line-icon glyphs matching ProductHeader's inline-SVG treatment — no
// external icon font/CDN dependency. Purely decorative category markers, one
// per SuggestedAction variant, so a card is scannable at a glance.
function EscalationIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 17 17 7" />
      <path d="M9 7h8v8" />
    </svg>
  );
}

function ReplyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </svg>
  );
}

function TicketIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4V8Z" />
      <path d="M12 7v10" strokeDasharray="2 2" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </svg>
  );
}

type CopyState = "idle" | "copied" | "error";

const COPY_STATE_RESET_MS = 2000;

// Follow-up polish pass, item 5 — a compact header CTA for
// DRAFT_CUSTOMER_REPLY cards that copies the reusable reply as plain text
// (Subject + Body), independent of card chrome or internal metadata. Purely
// a frontend convenience: no persistence, no change to the suggested-action
// contract.
function CopyReplyButton({ subject, body }: { readonly subject: string; readonly body: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const resetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimeoutRef.current !== null) clearTimeout(resetTimeoutRef.current);
    },
    [],
  );

  async function handleCopy() {
    const text = `Subject: ${subject}\n\n${body}`;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      // Clipboard access can fail (permissions, insecure context, an older
      // browser) — surface it as a transient "Copy failed" state rather than
      // throwing, so the rest of the card stays usable.
      setState("error");
    }

    if (resetTimeoutRef.current !== null) clearTimeout(resetTimeoutRef.current);
    resetTimeoutRef.current = setTimeout(() => setState("idle"), COPY_STATE_RESET_MS);
  }

  const label = state === "copied" ? "Copied" : state === "error" ? "Copy failed" : "Copy";

  return (
    <button type="button" className="suggested-action-copy-button" data-state={state} onClick={handleCopy}>
      <CopyIcon />
      {/* Text stays visible in every state, alongside the icon — never an
          icon-only control. */}
      {label}
    </button>
  );
}

// Issue #60 Checkpoint C: the compact muted grounding line shown on each card.
// Renders one span per locator and is omitted entirely for legacy rows whose
// groundedBy normalized to [] (the empty case is required for stored pre-#60
// actions). The evidenceId is part of the report evidence locator contract and
// already visible in ReportPanel, so surfacing it here exposes no new content.
function GroundingLine({
  locators,
}: {
  readonly locators: readonly SuggestedAction["groundedBy"][number][];
}) {
  if (locators.length === 0) return null;
  return (
    <p className="suggested-action-card__grounding">
      Grounded in:{" "}
      {locators.map((locator, index) => (
        <span key={`${locator.sourceType}:${locator.evidenceId}`}>
          {index > 0 && ", "}
          {humanizeEnum(locator.sourceType)} {locator.evidenceId}
        </span>
      ))}
    </p>
  );
}

// Renders every SuggestedAction variant exhaustively — a new contract
// variant would be caught by the exhaustive switch failing to compile.
export function SuggestedActionCard({ action }: SuggestedActionCardProps) {
  switch (action.type) {
    case "UPDATE_TICKET_STATUS":
      return (
        <article className="suggested-action-card">
          <div className="suggested-action-card-header">
            <span className="suggested-action-icon suggested-action-icon--ticket" aria-hidden="true">
              <TicketIcon />
            </span>
            <h4>Update ticket status</h4>
          </div>
          <dl>
            <div>
              <dt>New status</dt>
              <dd>
                <Chip tone={ticketStatusTone(action.payload.status)}>{humanizeEnum(action.payload.status)}</Chip>
              </dd>
            </div>
            <div>
              <dt>Reason</dt>
              <dd>{action.payload.reason}</dd>
            </div>
          </dl>
          <GroundingLine locators={action.groundedBy} />
        </article>
      );
    case "CREATE_ESCALATION":
      return (
        <article className="suggested-action-card">
          <div className="suggested-action-card-header">
            <span className="suggested-action-icon suggested-action-icon--escalation" aria-hidden="true">
              <EscalationIcon />
            </span>
            <h4>Create escalation</h4>
          </div>
          <dl>
            <div>
              <dt>Team</dt>
              <dd>{action.payload.team}</dd>
            </div>
            <div>
              <dt>Priority</dt>
              <dd>
                <Chip tone={priorityTone(action.payload.priority)}>{humanizeEnum(action.payload.priority)}</Chip>
              </dd>
            </div>
            <div>
              <dt>Reason</dt>
              <dd>{action.payload.reason}</dd>
            </div>
          </dl>
          <GroundingLine locators={action.groundedBy} />
        </article>
      );
    case "DRAFT_CUSTOMER_REPLY":
      return (
        <article className="suggested-action-card">
          <div className="suggested-action-card-header">
            <span className="suggested-action-icon suggested-action-icon--reply" aria-hidden="true">
              <ReplyIcon />
            </span>
            <h4>Draft customer reply</h4>
            <CopyReplyButton subject={action.payload.subject} body={action.payload.body} />
          </div>
          <dl>
            <div>
              <dt>Subject</dt>
              <dd>{action.payload.subject}</dd>
            </div>
          </dl>
          {/* Bounded rendering, not truncation — the full body (up to 4000
              chars per ResolutionReportSchema) stays readable so a reviewer
              can see exactly what they would be approving. */}
          <GroundingLine locators={action.groundedBy} />
          <div className="suggested-action-body">{action.payload.body}</div>
        </article>
      );
  }
}
