/** @bridge/ui-kit — tokens + primitives. One look, every surface.
 *
 *  CSS: import "@bridge/ui-kit/ui-kit.css" once per shell (it includes
 *  the tokens). Surfaces keep layout css only and may re-point tokens
 *  (palette overrides, density knobs) — never re-declare components. */
export { Btn, type BtnProps, type BtnVariant } from "./Btn";
export { Chip, type ChipProps, type ChipTone } from "./Chip";
export { Card, type CardProps } from "./Card";
export { Field, type FieldProps } from "./Field";
export { TextInput, TextArea, Select } from "./Inputs";
export { ActionRow, FormRow } from "./Rows";
export { ConnDot, type ConnState } from "./ConnDot";
export { RelTime } from "./RelTime.tsx";
export { relTime } from "./relTime";

// — knowledge plane: data layer + views (one rendering path, every surface) —
export { getKbHubConfig, setKbHubConfig, clearKbHubConfig, type KbMode } from "./server/config";
export {
  kbApi, KbAuthError, connectKbWs, setKbTransport, type KbTransport,
} from "./server/kb";
export type {
  KbArtefact, KbEvent, KbSession, KbAuthToken, KbGatewayAgentEdge,
  KbProgress, KbSeriesPoint, KbVersion, KbBoard, KbAsk, KbConsensus,
  KbReports, KbReportBucket,
} from "./server/kb";
export { useKb, kbConnected, setKbAuthEscalator, type BoardPrefs } from "./server/kbStore";
export {
  normTs, rel, clock, rankDecisions, actorEvents, latestTaskId,
  boardsOf, myAnswers, presenceLabel, kindOf, TASK_REF_RE,
} from "./server/views";
export { setCardLinkOpener, getCardLinkOpener } from "./views/refs";
export { DashboardSummary } from "./views/Dashboard";
export {
  TaskDetail, TaskStateCard, SentimentBar, RefText,
  SENTIMENT_CHIP, HISTORY_CHIP, HISTORY_LABEL,
} from "./views/TaskDetail";
export { TopView } from "./views/TopView";
export { ReportsView } from "./views/ReportsView";
export { BacklogView, CompletedView } from "./views/BacklogView";
export { StatusLights } from "./views/StatusLights";
export { ForMeView } from "./views/ForMeView";
export { DecisionPopover, decisionFrame } from "./views/decide";
