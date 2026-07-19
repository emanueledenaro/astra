/** @jsxImportSource @opentui/solid */

import type { AstraSessionAuthority } from "@astra/domain/session-authority"
import type {
  OperationViewDetailResult,
  OperationViewListResult,
  OperationViewRecoveryResult,
  OperationViewSummary,
} from "@astra/domain/operation-view-control"
import type { TuiPluginApi, TuiRouteCurrent } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useBindings } from "../../keymap"
import type { AstraOperationViewClient } from "../../astra/operation-view-client"

const routeName = "astra-operations"
const maximumRenderedEvents = 12
const maximumRenderedOperations = 16
const maximumRenderedCandidates = 8

export function AstraOperationsView(props: {
  api: TuiPluginApi
  mode: AstraSessionAuthority["mode"]
  client: AstraOperationViewClient
  returnRoute?: TuiRouteCurrent
}) {
  const dimensions = useTerminalDimensions()
  const [status, setStatus] = createSignal<"idle" | "loading" | "loaded" | "blocked">("idle")
  const [reason, setReason] = createSignal<string>()
  const [list, setList] = createSignal<Extract<OperationViewListResult, { status: "listed" }>>()
  const [recovery, setRecovery] = createSignal<Extract<OperationViewRecoveryResult, { status: "listed" }>>()
  const [detail, setDetail] = createSignal<Extract<OperationViewDetailResult, { status: "detailed" }>>()
  const [selected, setSelected] = createSignal(0)
  const operations = createMemo(() => list()?.operations.slice(0, maximumRenderedOperations) ?? [])
  const candidates = createMemo(() => recovery()?.candidates.slice(0, maximumRenderedCandidates) ?? [])

  const close = () => {
    if (detail()) {
      setDetail(undefined)
      return
    }
    props.client.dispose()
    props.api.route.navigate(
      props.returnRoute?.name ?? "home",
      props.returnRoute && "params" in props.returnRoute ? props.returnRoute.params : undefined,
    )
  }

  const refresh = async () => {
    if (status() === "loading") return
    setStatus("loading")
    setReason(undefined)
    setDetail(undefined)
    try {
      const listed = await props.client.list()
      if (listed.status === "blocked") {
        setList(undefined)
        setRecovery(undefined)
        setReason(listed.reason)
        setStatus("blocked")
        return
      }
      setList(listed)
      const recovered = await props.client.recovery()
      if (recovered.status === "blocked") {
        setRecovery(undefined)
        setReason(recovered.reason)
      } else {
        setRecovery(recovered)
      }
      setSelected((current) => Math.min(current, Math.max(listed.operations.length - 1, 0)))
      setStatus("loaded")
    } catch {
      setList(undefined)
      setRecovery(undefined)
      setReason("control_unavailable")
      setStatus("blocked")
    }
  }

  const open = async () => {
    const operation = operations()[selected()]
    if (!operation || status() === "loading") return
    setStatus("loading")
    setReason(undefined)
    try {
      const result = await props.client.detail(operation.operationID)
      if (result.status === "detailed") setDetail(result)
      else setReason(result.status === "not_found" ? "operation_not_found" : result.reason)
      setStatus("loaded")
    } catch {
      setReason("control_unavailable")
      setStatus("blocked")
    }
  }

  const move = (delta: number) => {
    if (detail()) return
    const count = operations().length
    if (count === 0) return
    setSelected((current) => Math.min(Math.max(current + delta, 0), count - 1))
  }

  onCleanup(() => props.client.dispose())

  useBindings(() => ({
    commands: [
      { name: "astra.operations.close", title: "Close Astra Operations", category: "Astra", run: close },
      { name: "astra.operations.refresh", title: "Refresh Operations", category: "Astra", run: refresh },
      { name: "astra.operations.detail", title: "Open Operation Detail", category: "Astra", run: open },
      { name: "astra.operations.next", title: "Next Operation", category: "Astra", run: () => move(1) },
      { name: "astra.operations.previous", title: "Previous Operation", category: "Astra", run: () => move(-1) },
    ],
    bindings: [
      { key: "escape", cmd: "astra.operations.close", desc: "Close Astra Operations" },
      { key: "r", cmd: "astra.operations.refresh", desc: "Refresh Operations" },
      { key: "return", cmd: "astra.operations.detail", desc: "Open Operation Detail" },
      { key: "down", cmd: "astra.operations.next", desc: "Next Operation" },
      { key: "up", cmd: "astra.operations.previous", desc: "Previous Operation" },
    ],
  }))

  return (
    <box
      position="absolute"
      zIndex={2500}
      left={0}
      top={0}
      width={dimensions().width}
      height={dimensions().height}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
    >
      <box flexDirection="row" flexShrink={0}>
        <text fg={props.api.theme.current.text}>Operations</text>
        <box flexGrow={1} />
        <text fg={props.api.theme.current.textMuted}>esc</text>
      </box>
      <text fg={props.api.theme.current.textMuted}>DURABLE LEDGER • READ ONLY • NO ACTION RUNS FROM THIS VIEW</text>
      <box height={1} />
      <Row label="MODE" value={props.mode === "read-only" ? "READ ONLY" : "ACTIVE ONCE"} api={props.api} />
      <Row
        label="STATE"
        value={status() === "idle" ? "NOT LOADED • R refresh" : status().toUpperCase()}
        api={props.api}
      />
      <Row label="COVERAGE" value="DISPATCHED OPERATIONS ONLY" api={props.api} />
      <Show when={reason()}>{(value) => <Row label="BLOCKED" value={value()} api={props.api} />}</Show>
      <Show when={!detail()}>
        <box height={1} />
        <Show when={list()} fallback={<text fg={props.api.theme.current.textMuted}>No ledger projection loaded.</text>}>
          <Show
            when={operations().length > 0}
            fallback={<text fg={props.api.theme.current.textMuted}>No dispatched operations in the ledger.</text>}
          >
            <For each={operations()}>
              {(operation, index) => (
                <box flexDirection="row" flexShrink={0}>
                  <text width={2} fg={props.api.theme.current.textMuted}>
                    {index() === selected() ? ">" : " "}
                  </text>
                  <text width={22} fg={stateColor(props.api, operation)}>
                    {statePill(operation)}
                  </text>
                  <text fg={props.api.theme.current.text}>
                    {`${operation.intentKind} • ${operation.operationID.slice(0, 8)} • ${operation.updatedAt}`}
                  </text>
                </box>
              )}
            </For>
          </Show>
        </Show>
        <Show when={recovery()}>
          {(recovered) => (
            <>
              <box height={1} />
              <text fg={props.api.theme.current.warning}>
                RECOVERY CANDIDATES — recovery is not retry — ambiguity is preserved
              </text>
              <Show
                when={candidates().length > 0}
                fallback={
                  <text fg={props.api.theme.current.textMuted}>No dispatch records awaiting recovery review.</text>
                }
              >
                <For each={candidates()}>
                  {(candidate) => (
                    <Row
                      label={candidate.recoveryStatus === "claim_uncertain" ? "UNCERTAIN" : "DISPATCH"}
                      value={`${candidate.recoveryStatus.replaceAll("_", " ").toUpperCase()} • op ${candidate.operationID.slice(0, 8)} • ${candidate.executor}`}
                      api={props.api}
                    />
                  )}
                </For>
              </Show>
              <Show when={recovered().candidates.length > maximumRenderedCandidates}>
                <text fg={props.api.theme.current.textMuted}>
                  {`… ${recovered().candidates.length - maximumRenderedCandidates} more candidates in the ledger`}
                </text>
              </Show>
            </>
          )}
        </Show>
      </Show>
      <Show when={detail()}>
        {(opened) => (
          <>
            <box height={1} />
            <Row label="OPERATION" value={opened().operation.operationID} api={props.api} />
            <Row label="INTENT" value={opened().operation.intentKind} api={props.api} />
            <box flexDirection="row" flexShrink={0}>
              <text width={13} fg={props.api.theme.current.textMuted}>
                STATE
              </text>
              <text fg={stateColor(props.api, opened().operation)}>{statePill(opened().operation)}</text>
            </box>
            <Row label="UPDATED" value={opened().operation.updatedAt} api={props.api} />
            <Show when={opened().dispatch}>
              {(dispatch) => (
                <>
                  <Row
                    label="DISPATCH"
                    value={`${dispatch().recoveryStatus.replaceAll("_", " ").toUpperCase()} • ${dispatch().executor ?? "unclaimed"}`}
                    api={props.api}
                  />
                  <Show when={dispatch().receipt}>
                    {(receipt) => (
                      <Row
                        label="RECEIPT"
                        value={`${receipt().outcome.replaceAll("_", " ").toUpperCase()} • ${receipt().receiptID.slice(0, 8)} • ${receipt().endedAt}`}
                        api={props.api}
                      />
                    )}
                  </Show>
                  <Show when={dispatch().uncertainty}>
                    {(uncertainty) => (
                      <text fg={props.api.theme.current.error}>
                        {`EFFECT UNKNOWN • ${uncertainty().reason.replaceAll("_", " ")} • preserved, not retried`}
                      </text>
                    )}
                  </Show>
                </>
              )}
            </Show>
            <Show
              when={opened().verification}
              fallback={<Row label="EVIDENCE" value="NONE — NOT VERIFIED" api={props.api} />}
            >
              {(verification) => (
                <>
                  <Row
                    label="EVIDENCE"
                    value={`${verification().verifier} • ${verification().evidenceDigest.slice(0, 15)}…`}
                    api={props.api}
                  />
                  <For each={verification().criteria}>
                    {(criterion) => (
                      <Row
                        label="CRITERION"
                        value={`${criterion.criterionID} • ${criterion.result.toUpperCase()}`}
                        api={props.api}
                      />
                    )}
                  </For>
                </>
              )}
            </Show>
            <box height={1} />
            <text fg={props.api.theme.current.textMuted}>
              {`EVENTS • ${opened().events.length} recorded • hash-chained`}
            </text>
            <For each={opened().events.slice(-maximumRenderedEvents)}>
              {(event) => (
                <Row
                  label={`#${event.sequence}`}
                  value={`${event.name} • ${event.actorKind} • ${event.observedAt} • ${event.digest.slice(7, 15)}`}
                  api={props.api}
                />
              )}
            </For>
            <Show when={opened().events.length > maximumRenderedEvents}>
              <text fg={props.api.theme.current.textMuted}>
                {`… ${opened().events.length - maximumRenderedEvents} earlier events in the ledger`}
              </text>
            </Show>
          </>
        )}
      </Show>
      <box height={1} />
      <text fg={props.api.theme.current.textMuted}>
        R refresh • up/down select • enter detail • esc {detail() ? "back" : "close"}.
      </text>
    </box>
  )
}

function statePill(operation: OperationViewSummary) {
  if (operation.semanticKey === "VERIFIED") return "VERIFIED"
  if (operation.semanticKey === "EFFECT_OBSERVED") return "EFFECT OBSERVED — NOT VERIFIED"
  if (operation.semanticKey === "COMPLETED") return "COMPLETED — NOT VERIFIED"
  if (operation.semanticKey === "RECONCILIATION_REQUIRED") return "RECONCILIATION REQUIRED"
  return operation.semanticKey.replaceAll("_", " ")
}

function stateColor(api: TuiPluginApi, operation: OperationViewSummary) {
  if (operation.semanticKey === "VERIFIED") return api.theme.current.success
  if (operation.semanticKey === "RECONCILIATION_REQUIRED" || operation.semanticKey === "FAILED") {
    return api.theme.current.error
  }
  if (
    operation.semanticKey === "EFFECT_OBSERVED" ||
    operation.semanticKey === "COMPLETED" ||
    operation.semanticKey === "INCONCLUSIVE"
  ) {
    return api.theme.current.warning
  }
  return api.theme.current.text
}

function Row(props: { label: string; value: string; api: TuiPluginApi }) {
  return (
    <box flexDirection="row" flexShrink={0}>
      <text width={13} fg={props.api.theme.current.textMuted}>
        {props.label}
      </text>
      <text fg={props.api.theme.current.text}>{props.value}</text>
    </box>
  )
}

export function registerAstraOperations(
  api: TuiPluginApi,
  authority: AstraSessionAuthority,
  client: AstraOperationViewClient,
) {
  api.route.register([
    {
      name: routeName,
      render: (input) => (
        <AstraOperationsView
          api={api}
          mode={authority.mode}
          client={client}
          returnRoute={parseReturnRoute(input.params?.returnRoute)}
        />
      ),
    },
  ])

  api.keymap.registerLayer({
    commands: [
      {
        name: "astra.operations.open",
        title: "Operations",
        slashName: "operations",
        category: "Astra",
        namespace: "palette",
        run() {
          api.route.navigate(routeName, { returnRoute: api.route.current })
          api.ui.dialog.clear()
        },
      },
    ],
  })
}

function parseReturnRoute(input: unknown): TuiRouteCurrent | undefined {
  if (!isRecord(input) || typeof input.name !== "string") return undefined
  if (!("params" in input)) return { name: input.name }
  if (!isRecord(input.params)) return undefined
  return { name: input.name, params: input.params }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}
