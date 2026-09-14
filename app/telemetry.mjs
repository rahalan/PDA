// Non-authoritative OpenTelemetry mirror of the compliance ledger.
//
// The signed append-only ledger remains the system of record. When enabled, each
// ledger append is also emitted as an OpenTelemetry log record for observability
// (dashboards and alerting). Only allow-listed metadata fields
// are exported — never signatures, secrets, prompts, tool arguments/results, or
// credentials. Metadata can still be sensitive; delivery is best-effort.

const NOOP = { onLedgerAppend: null, shutdown: async () => {} };

// Explicit allow-list. Anything not listed here is never exported.
function projectAttributes(record) {
  const attributes = {
    'ledger.seq': record.seq,
    'ledger.kind': record.kind,
    'ledger.id': record.id,
    'ledger.digest': record.hash,
    'ledger.previous_hash': record.previousHash,
    'ledger.timestamp': record.timestamp,
  };
  const optional = {
    'pda.chat_id': record.chatId,
    'pda.agent_id': record.agentId,
    'pda.level': record.level,
    'pda.sovereignty': record.sovereignty,
    'pda.route_id': record.routeId,
    'pda.model': record.model,
    'pda.outcome': record.outcome,
    'pda.policy_version': record.policyVersion,
    'pda.policy_digest': record.policyDigest,
    'pda.tool_id': record.toolId,
    'pda.http_status': record.httpStatus,
    'pda.provider_detail': record.detail,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined && value !== null && value !== '') {
      attributes[key] = typeof value === 'object' ? undefined : value;
    }
  }
  return attributes;
}

export async function initTelemetry() {
  if (process.env.PDA_OTEL_ENABLED !== '1') {
    return NOOP;
  }
  const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!connectionString) {
    return NOOP;
  }

  try {
    const { AzureMonitorLogExporter } = await import('@azure/monitor-opentelemetry-exporter');
    const { LoggerProvider, BatchLogRecordProcessor } = await import('@opentelemetry/sdk-logs');
    const exporter = new AzureMonitorLogExporter({ connectionString, disableOfflineStorage: true });
    const provider = new LoggerProvider({ forceFlushTimeoutMillis: 3000 });
    provider.addLogRecordProcessor(new BatchLogRecordProcessor(exporter, {
      maxQueueSize: 256, maxExportBatchSize: 32, scheduledDelayMillis: 1000, exportTimeoutMillis: 3000,
    }));
    const logger = provider.getLogger('pda.ledger');

    const onLedgerAppend = (record) => {
      logger.emit({
        severityNumber: 9,
        severityText: 'INFO',
        body: `ledger.${record.kind}`,
        attributes: projectAttributes(record),
      });
    };

    return { onLedgerAppend, shutdown: () => provider.shutdown() };
  } catch {
    // If OpenTelemetry packages or the exporter fail to initialise, run without a
    // telemetry mirror. The ledger is unaffected.
    return NOOP;
  }
}
