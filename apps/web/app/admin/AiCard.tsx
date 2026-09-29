"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client";
import { fmtDateTime } from "@/lib/format";

interface Model {
  id: string;
  name: string;
  kind: "chat" | "transcription";
  contextLength: number | null;
  input: string[];
  price: { input: number | null; output: number | null; audio: number | null; image: number | null; perMinute: number | null };
  free: boolean;
  created: number;
}
interface Settings {
  platformEnabled: boolean;
  enabled: boolean;
  hasKey: boolean;
  keyHint: string | null;
  model: string | null;
  transcriptionModel: string | null;
  zeroRetention: boolean;
  updatedAt: string | null;
  usageThisMonth: { feature: string; model: string; calls: number; failed: number; cost: number | null; input: number; output: number }[];
}
interface TestResult {
  reply: string;
  costUsd: number | null;
  latencyMs: number;
  credit: { limit: number | null; limitRemaining: number | null; usage: number | null; isFreeTier: boolean };
}

type Run = (fn: () => Promise<unknown>, ok?: string) => Promise<void>;
type Sort = "input" | "output" | "typical" | "name" | "newest";

// Uso típico para comparar: resumo de caso ≈ 4 mil tokens de entrada + 1 mil de saída.
const TYPICAL_IN = 4000;
const TYPICAL_OUT = 1000;
const typical = (m: Model) => (m.price.input === null || m.price.output === null ? null : (m.price.input * TYPICAL_IN + m.price.output * TYPICAL_OUT) / 1e6);

const usd = (v: number | null, digits = 2) => (v === null ? "variável" : v === 0 ? "grátis" : `US$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: 4 })}`);
const INPUT_LABEL: Record<string, string> = { text: "texto", image: "imagem", audio: "áudio", file: "PDF", video: "vídeo" };
const FEATURE_LABEL: Record<string, string> = { "admin.test": "Teste de conexão" };

export function AiCard({ run }: { run: Run }) {
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [models, setModels] = useState<Model[] | null>(null);
  const [key, setKey] = useState("");
  const [picking, setPicking] = useState<"chat" | "transcription" | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const load = () =>
    api<Settings>("GET", "/v1/admin/ai")
      .then(setS)
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (!s?.platformEnabled || models) return;
    api<{ models: Model[] }>("GET", "/v1/admin/ai/models")
      .then((r) => setModels(r.models))
      .catch((e: Error) => setError(e.message));
  }, [s?.platformEnabled, models]);

  // Mensagens ficam no próprio cartão (ele fica no fim da página); run só atualiza o contexto do menu.
  const save = async (body: Record<string, unknown>, ok: string): Promise<boolean> => {
    setError(null);
    setMsg(null);
    try {
      await api("PUT", "/v1/admin/ai", { body });
      setTest(null);
      setMsg(ok);
      await load();
      await run(async () => undefined);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  if (!s) return <div className="card">{error ? <div className="alert bad">{error}</div> : <p className="muted">Carregando IA…</p>}</div>;
  if (!s.platformEnabled)
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Inteligência artificial</h2>
        <p className="muted small">A IA não está disponível nesta instalação (AI_PROVIDER). Fale com o operador da plataforma.</p>
      </div>
    );

  const byId = (id: string | null) => models?.find((m) => m.id === id);
  const chosen = byId(s.model);
  const chosenStt = byId(s.transcriptionModel);
  const monthCost = s.usageThisMonth.reduce((a, u) => a + (u.cost ?? 0), 0);

  return (
    <div className="card">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Inteligência artificial</h2>
        <span className={`badge ${s.enabled ? "ok" : "plain"}`}>{s.enabled ? "habilitada" : "desabilitada"}</span>
      </div>
      <p className="muted small">
        Via <a href="https://openrouter.ai" target="_blank" rel="noreferrer">OpenRouter</a>, com a conta da própria equipe. A IA só
        propõe: todo texto sugerido é revisado e confirmado pelo médico antes de entrar no registro.
      </p>
      {error && <div className="alert bad">{error}</div>}
      {msg && <div className="alert ok">{msg}</div>}

      <h3>1. Chave do OpenRouter</h3>
      {s.hasKey && (
        <p className="small">
          Chave salva: <code>••••{s.keyHint}</code>{" "}
          <button
            className="link"
            onClick={() => {
              if (confirm("Remover a chave? A IA fica desabilitada para toda a equipe.")) void save({ apiKey: null }, "Chave removida.");
            }}
          >
            remover
          </button>
        </p>
      )}
      <div className="row">
        <input
          type="password"
          autoComplete="off"
          placeholder={s.hasKey ? "Trocar chave (sk-or-…)" : "Cole a chave (sk-or-…)"}
          aria-label="Chave do OpenRouter"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          style={{ minWidth: 320 }}
        />
        <button
          disabled={key.trim().length < 20}
          onClick={() =>
            void save({ apiKey: key.trim() }, "Chave validada e salva.").then((ok) => ok && setKey(""))
          }
        >
          Validar e salvar
        </button>
      </div>
      <p className="small muted">
        Crie em openrouter.ai → Keys. Dica: defina lá um limite de crédito para a chave. A chave fica cifrada no servidor e não volta ao
        navegador.
      </p>

      <h3>2. Modelos</h3>
      <div className="grid2">
        <div>
          <label>Modelo principal (texto; com imagem serve para OCR)</label>
          <div className="small">
            {s.model ? (
              <>
                <strong>{chosen?.name ?? s.model}</strong>
                {chosen && <PriceLine m={chosen} />}
              </>
            ) : (
              <span className="muted">nenhum</span>
            )}
          </div>
          <button className="link" onClick={() => setPicking(picking === "chat" ? null : "chat")}>
            {picking === "chat" ? "fechar lista" : s.model ? "trocar modelo" : "escolher modelo"}
          </button>
        </div>
        <div>
          <label>Transcrição de voz (opcional)</label>
          <div className="small">
            {s.transcriptionModel ? (
              <>
                <strong>{chosenStt?.name ?? s.transcriptionModel}</strong>
                {chosenStt && <PriceLine m={chosenStt} />}
              </>
            ) : (
              <span className="muted">nenhum</span>
            )}
          </div>
          <button className="link" onClick={() => setPicking(picking === "transcription" ? null : "transcription")}>
            {picking === "transcription" ? "fechar lista" : s.transcriptionModel ? "trocar modelo" : "escolher modelo"}
          </button>
          {s.transcriptionModel && (
            <>
              {" · "}
              <button className="link" onClick={() => void save({ transcriptionModel: null }, "Transcrição removida.")}>
                remover
              </button>
            </>
          )}
        </div>
      </div>
      {picking &&
        (models ? (
          <ModelPicker
            kind={picking}
            models={models}
            current={picking === "chat" ? s.model : s.transcriptionModel}
            onPick={(id) => {
              setPicking(null);
              void save(picking === "chat" ? { model: id } : { transcriptionModel: id }, "Modelo salvo.");
            }}
          />
        ) : (
          <p className="muted small">Carregando catálogo do OpenRouter…</p>
        ))}

      <h3>3. Privacidade e ativação</h3>
      <label className="row">
        <input
          type="checkbox"
          checked={s.zeroRetention}
          onChange={(e) => {
            const on = e.target.checked;
            if (!on && !confirm("Permitir provedores que podem guardar o que é enviado? Mais modelos ficam disponíveis, inclusive grátis.")) return;
            void save({ zeroRetention: on }, on ? "Somente provedores sem retenção." : "Retenção permitida.");
          }}
        />
        <span>
          <strong>Só provedores que não guardam os dados</strong>
          <span className="small muted"> — o OpenRouter roteia apenas para provedores com retenção zero. Alguns modelos (e quase todos os grátis) deixam de atender.</span>
        </span>
      </label>
      <label className="row">
        <input
          type="checkbox"
          checked={s.enabled}
          disabled={!s.hasKey || !s.model}
          onChange={(e) => void save({ enabled: e.target.checked }, e.target.checked ? "IA habilitada para a equipe." : "IA desabilitada.")}
        />
        <span>
          <strong>Habilitar IA na equipe</strong>
          <span className="small muted"> — {!s.hasKey || !s.model ? "salve a chave e escolha o modelo primeiro." : "os recursos de IA aparecem para os membros."}</span>
        </span>
      </label>
      <div className="row" style={{ marginTop: 8 }}>
        <button
          disabled={!s.hasKey || !s.model || testing}
          onClick={async () => {
            setTesting(true);
            setTest(null);
            setError(null);
            try {
              setTest(await api<TestResult>("POST", "/v1/admin/ai/test"));
              await load();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setTesting(false);
            }
          }}
        >
          {testing ? "Testando…" : "Testar conexão"}
        </button>
        {test && (
          <span className="small">
            <span className="badge ok">funcionou</span> resposta “{test.reply}” em {(test.latencyMs / 1000).toFixed(1)} s · custo {usd(test.costUsd, 6)}
            {test.credit.limitRemaining !== null && ` · crédito restante na chave ${usd(test.credit.limitRemaining)}`}
          </span>
        )}
      </div>
      {s.updatedAt && <p className="small muted">Última alteração: {fmtDateTime(s.updatedAt)}</p>}

      <h3>Consumo no mês</h3>
      {s.usageThisMonth.length === 0 ? (
        <p className="small muted">Nenhum uso ainda.</p>
      ) : (
        <div className="table-wrap">
          <table className="small">
            <thead>
              <tr>
                <th>Recurso</th>
                <th>Modelo</th>
                <th>Chamadas</th>
                <th>Tokens (entrada/saída)</th>
                <th>Custo</th>
              </tr>
            </thead>
            <tbody>
              {s.usageThisMonth.map((u) => (
                <tr key={`${u.feature}|${u.model}`}>
                  <td>{FEATURE_LABEL[u.feature] ?? u.feature}</td>
                  <td>{u.model}</td>
                  <td>
                    {u.calls}
                    {u.failed > 0 && <span className="muted"> ({u.failed} com erro)</span>}
                  </td>
                  <td>
                    {u.input.toLocaleString("pt-BR")} / {u.output.toLocaleString("pt-BR")}
                  </td>
                  <td>{usd(u.cost, 4)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={4}>
                  <strong>Total</strong>
                </td>
                <td>
                  <strong>{usd(monthCost, 4)}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted">Registra só recurso, modelo, tokens e custo, nunca o conteúdo enviado.</p>
    </div>
  );
}

function PriceLine({ m }: { m: Model }) {
  if (m.price.perMinute !== null) return <div className="muted">{usd(m.price.perMinute, 4)} por minuto de áudio</div>;
  const t = typical(m);
  return (
    <div className="muted">
      entrada {usd(m.price.input)} · saída {usd(m.price.output)} por 1 M tokens
      {t !== null && ` · ≈ ${usd(t, 4)} por resumo de caso`}
    </div>
  );
}

function ModelPicker({ kind, models, current, onPick }: { kind: Model["kind"]; models: Model[]; current: string | null; onPick: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [needImage, setNeedImage] = useState(false);
  const [needAudio, setNeedAudio] = useState(false);
  const [freeOnly, setFreeOnly] = useState(false);
  const [sort, setSort] = useState<Sort>(kind === "chat" ? "typical" : "input");
  const [limit, setLimit] = useState(40);

  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const costOf = (m: Model) => (sort === "typical" ? typical(m) : sort === "output" ? m.price.output : (m.price.perMinute ?? m.price.input));
    return models
      .filter((m) => m.kind === kind)
      .filter((m) => words.every((w) => `${m.id} ${m.name}`.toLowerCase().includes(w)))
      .filter((m) => !needImage || m.input.includes("image"))
      .filter((m) => !needAudio || m.input.includes("audio"))
      .filter((m) => !freeOnly || m.free)
      .sort((a, b) => {
        if (sort === "name") return a.name.localeCompare(b.name);
        if (sort === "newest") return b.created - a.created;
        return (costOf(a) ?? Infinity) - (costOf(b) ?? Infinity);
      });
  }, [models, kind, q, needImage, needAudio, freeOnly, sort]);

  return (
    <div className="card" style={{ marginTop: 8 }}>
      <div className="row">
        <input placeholder="Buscar (ex.: claude, gemini, gpt, llama)" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 260 }} autoFocus />
        <select aria-label="Ordenar" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          {kind === "chat" && <option value="typical">mais barato por resumo</option>}
          <option value="input">{kind === "chat" ? "mais barato na entrada" : "mais barato"}</option>
          {kind === "chat" && <option value="output">mais barato na saída</option>}
          <option value="newest">mais recentes</option>
          <option value="name">nome</option>
        </select>
        {kind === "chat" && (
          <>
            <label className="row">
              <input type="checkbox" checked={needImage} onChange={(e) => setNeedImage(e.target.checked)} /> lê imagem (OCR)
            </label>
            <label className="row">
              <input type="checkbox" checked={needAudio} onChange={(e) => setNeedAudio(e.target.checked)} /> ouve áudio
            </label>
          </>
        )}
        <label className="row">
          <input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} /> só grátis
        </label>
      </div>
      <p className="small muted">
        {list.length} modelos. Preços em dólar, informados pelo OpenRouter
        {kind === "chat" ? `; "por resumo" estima ${TYPICAL_IN / 1000} mil tokens de entrada + ${TYPICAL_OUT / 1000} mil de saída` : ""}. O custo real de
        cada chamada aparece em Consumo.
      </p>
      <div className="table-wrap">
        <table className="small">
          <thead>
            <tr>
              <th>Modelo</th>
              {kind === "chat" ? (
                <>
                  <th>Entrada / 1 M</th>
                  <th>Saída / 1 M</th>
                  <th>≈ por resumo</th>
                  <th>Contexto</th>
                  <th>Lê</th>
                </>
              ) : (
                <th>Preço</th>
              )}
              <th />
            </tr>
          </thead>
          <tbody>
            {list.slice(0, limit).map((m) => (
              <tr key={m.id}>
                <td>
                  <strong>{m.name}</strong>
                  <div className="muted">{m.id}</div>
                </td>
                {kind === "chat" ? (
                  <>
                    <td>{usd(m.price.input)}</td>
                    <td>{usd(m.price.output)}</td>
                    <td>{usd(typical(m), 4)}</td>
                    <td>{m.contextLength ? `${Math.round(m.contextLength / 1000).toLocaleString("pt-BR")} mil` : "—"}</td>
                    <td>{m.input.map((i) => INPUT_LABEL[i] ?? i).join(", ")}</td>
                  </>
                ) : (
                  <td>{m.price.perMinute !== null ? `${usd(m.price.perMinute, 4)}/min` : `${usd(m.price.input)} entrada · ${usd(m.price.output)} saída / 1 M tokens`}</td>
                )}
                <td>{m.id === current ? <span className="badge ok">atual</span> : <button onClick={() => onPick(m.id)}>Escolher</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length > limit && (
        <button className="link" onClick={() => setLimit(limit + 40)}>
          mostrar mais
        </button>
      )}
    </div>
  );
}
