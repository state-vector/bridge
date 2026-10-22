/** shim — the knowledge client moved into @bridge/ui-kit (one data layer,
 *  every surface). Re-exported here so the existing webapp imports hold. */
export {
  kbApi, KbAuthError, connectKbWs,
} from "@bridge/ui-kit";
export type {
  KbArtefact, KbEvent, KbSession, KbAuthToken, KbGatewayAgentEdge,
  KbProgress, KbSeriesPoint, KbVersion, KbBoard,
} from "@bridge/ui-kit";
