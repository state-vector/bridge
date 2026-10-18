BR#522 verification verdict

Receipts checked:
- `bridge_get_artefact BR#521`
- `bridge_get_history BR#521`
- `bridge_related_artefacts BR#521`
- `bridge_asks`

Finding:
- BR#521 is a verifier wrapper around BR#520 and the live record still points to the same missing-receipt pattern.
- The history shows the prior verdict for BR#520: no resolvable implementation PR or merge-state receipt exists in this session, so the correct outcome is bounce rather than close.
- No new evidence surfaced that would justify reclassifying the underlying work as done.

Result:
- BR#521 should remain not closed as done; the verification evidence supports a bounced verdict.
