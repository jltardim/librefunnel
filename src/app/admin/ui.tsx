"use client";

import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { buttonAttributes } from "@/components/action/button";
import { SaveBar } from "@/components/form/save-bar";
import { CopyButton } from "@/components/action/copy-button";
import { SubmitButton } from "@/components/action/submit-button";
import { Row } from "@/components/layout/row";
import { Stack } from "@/components/layout/stack";
import { Text } from "@/components/text/text";
import type { ActionState, Code } from "@/lib/actions/form";
import { adminSignIn } from "@/lib/actions/store";
import { connectWhatsApp, rotateWebhookSecret } from "@/lib/actions/connections";
import { releaseOrder } from "@/lib/actions/orders";
import type { Json } from "@/lib/guard";
import { ErrorText, RefreshWhilePending } from "@/app/ui";
import copyStyles from "@/components/action/copy-field.module.css";
import styles from "./admin.module.css";
import { formatFileTitle } from "@/format";

type Look = ReturnType<typeof buttonAttributes>;
type FormAction = (state: ActionState, formData: FormData) => Promise<ActionState>;

const UPLOAD_CODES = ["MEDIA_TYPE", "MEDIA_TOO_LARGE", "UPLOAD_FAILED", "NOT_SIGNED_IN", "DEMO_BLOCKED"] as const;

function Feedback({ code, done }: { code: Code | null; done?: string | false }) {
  return (
    <div aria-live="polite">
      {code ? (
        <Text variant="body-sm" tone="danger">
          <ErrorText code={code} />
        </Text>
      ) : done ? (
        <Text variant="body-sm" tone="success">
          {done}
        </Text>
      ) : null}
    </div>
  );
}

export function AdminSignInForm({ button, label, children }: { button: Look; label: string; children: ReactNode }) {
  const [state, action, pending] = useActionState(adminSignIn, { code: null });

  return (
    <form action={action}>
      <Stack gap={4}>
        {children}
        <Feedback code={state.code} />
        <SubmitButton {...button}>{pending ? "Entrando" : label}</SubmitButton>
      </Stack>
    </form>
  );
}

export function ActionButton({
  action,
  fields = {},
  label,
  pendingLabel,
  done,
  button,
}: {
  action: FormAction;
  fields?: Record<string, string>;
  label: ReactNode;
  pendingLabel: string;
  done?: string;
  button: Look;
}) {
  const [state, formAction, pending] = useActionState(action, { code: null });

  return (
    <form action={formAction}>
      <Stack gap={2}>
        {Object.entries(fields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <div>
          <SubmitButton {...button}>
            {!pending ? (
              label
            ) : button["data-icon-only"] ? (
              <span className="sr-only">{pendingLabel}</span>
            ) : (
              pendingLabel
            )}
          </SubmitButton>
        </div>
        <Feedback code={state.code} done={state.ok && done} />
      </Stack>
    </form>
  );
}

export function ReleaseForm({ orderId, button, children }: { orderId: string; button: Look; children: ReactNode }) {
  const [state, action, pending] = useActionState(releaseOrder, { code: null });

  if (state.ok) {
    return (
      <Text variant="body-sm" tone="success">
        Pedido liberado. O e-mail de acesso sai em instantes.
      </Text>
    );
  }

  return (
    <form action={action}>
      <Stack gap={3}>
        <input type="hidden" name="orderId" value={orderId} />
        {children}
        <Feedback code={state.code} />
        <div>
          <SubmitButton {...button}>{pending ? "Liberando" : "Liberar acesso"}</SubmitButton>
        </div>
      </Stack>
    </form>
  );
}

// Submits without React's automatic form reset, so a validation error never wipes what the seller typed.
export function SaveForm({
  action,
  label,
  pendingLabel,
  done,
  reset,
  bar,
  button,
  children,
}: {
  action: FormAction;
  label: ReactNode;
  pendingLabel: string;
  done?: string;
  reset?: boolean;
  bar?: boolean;
  button?: Look;
  children: ReactNode;
}) {
  const [state, dispatch, pending] = useActionState(action, { code: null });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (state.ok && reset) setVersion((current) => current + 1);
  }, [state, reset]);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();

        const fields = new FormData(event.currentTarget);

        startTransition(() => dispatch(fields));
      }}
    >
      <Stack gap={4}>
        <fieldset className={styles.fieldset} disabled={pending} key={version}>
          {children}
        </fieldset>
        <Feedback code={state.code} done={state.ok && done} />
        {bar ? (
          <SaveBar busy={pending} />
        ) : (
          <div>
            <SubmitButton busy={pending} {...button}>
              {pending ? pendingLabel : label}
            </SubmitButton>
          </div>
        )}
      </Stack>
    </form>
  );
}

// Uploads go to a route handler as the raw file body: XHR is the only browser API that reports upload progress.
export function MediaUpload({
  id,
  "aria-describedby": describedBy,
  name,
  kind,
  value,
  button,
  remove,
  titleField,
  originalName,
}: {
  id: string;
  "aria-describedby"?: string;
  name: string;
  kind: "video" | "image" | "captions" | "pdf";
  value?: string;
  button: Look;
  remove: Look;
  titleField?: string;
  originalName?: { field: string; value?: string };
}) {
  const [path, setPath] = useState(value ?? "");
  const [fileName, setFileName] = useState(originalName?.value ?? "");
  const [progress, setProgress] = useState<number | null>(null);
  const [code, setCode] = useState<Code | null>(null);
  const hidden = useRef<HTMLInputElement>(null);

  function choose(next: string, uploaded = "") {
    setPath(next);
    setFileName(uploaded);
    // The hidden input changes without a user event, so the form's unsaved-changes bar would not notice.
    queueMicrotask(() => hidden.current?.dispatchEvent(new Event("input", { bubbles: true })));
  }

  // One XHR per request so the bar can show upload progress, which fetch cannot report.
  function send(method: string, url: string, body: Blob | string, onProgress: (loaded: number) => void) {
    return new Promise<{ status: number; reply: { [key: string]: Json }; etag: string | null }>((resolve, reject) => {
      const request = new XMLHttpRequest();

      request.open(method, url);
      request.upload.onprogress = (event) => onProgress(event.loaded);
      request.onerror = () => reject(new Error("network"));
      request.onload = () => {
        let body: Json = null;

        try {
          body = JSON.parse(request.responseText);
        } catch {}

        resolve({
          status: request.status,
          reply: typeof body === "object" && body !== null && !Array.isArray(body) ? body : {},
          etag: request.getResponseHeader("ETag"),
        });
      };
      request.send(body);
    });
  }

  function failed(status: number, reply: { [key: string]: Json }) {
    const reported = UPLOAD_CODES.find((entry) => entry === reply.code);

    setCode(reported ?? (status === 413 ? "MEDIA_TOO_LARGE" : "UPLOAD_FAILED"));
  }

  async function upload(file: File) {
    const percent = (loaded: number) => setProgress(Math.round((loaded / Math.max(file.size, 1)) * 100));

    setCode(null);
    setProgress(0);

    try {
      const start = await send(
        "POST",
        "/admin/media/direct",
        JSON.stringify({ step: "start", name: file.name, size: file.size }),
        () => undefined,
      );

      const { file: key, uploadId, partSize, urls } = start.reply;

      if (start.reply.local === true) {
        const local = await send("POST", `/admin/media?${new URLSearchParams({ name: file.name })}`, file, percent);

        if (typeof local.reply.path === "string") return choose(local.reply.path, file.name);
        return failed(local.status, local.reply);
      }

      if (
        typeof key !== "string" ||
        typeof uploadId !== "string" ||
        typeof partSize !== "number" ||
        !Array.isArray(urls)
      )
        return failed(start.status, start.reply);

      const parts: { number: number; etag: string }[] = [];

      for (const [index, url] of urls.entries()) {
        if (typeof url !== "string") return failed(0, {});
        const offset = index * partSize;

        const part = await send("PUT", url, file.slice(offset, offset + partSize), (loaded) =>
          percent(offset + loaded),
        );

        if (part.status >= 300 || !part.etag) return failed(part.status, {});
        parts.push({ number: index + 1, etag: part.etag });
      }

      const finish = await send(
        "POST",
        "/admin/media/direct",
        JSON.stringify({ step: "finish", file: key, uploadId, parts }),
        () => undefined,
      );

      if (typeof finish.reply.path === "string") return choose(finish.reply.path, file.name);
      failed(finish.status, finish.reply);
    } catch {
      setCode("UPLOAD_FAILED");
    } finally {
      setProgress(null);
    }
  }

  return (
    <Stack gap={2}>
      <input ref={hidden} type="hidden" name={name} value={path} />
      {originalName ? <input type="hidden" name={originalName.field} value={fileName} /> : null}
      <Row gap={3}>
        {!path ? (
          <Text variant="body-sm" tone="muted">
            Nenhum arquivo
          </Text>
        ) : kind === "image" ? (
          <img className={styles.thumb} src={path} alt="" />
        ) : kind === "captions" ? (
          <Text variant="body-sm">Legenda enviada</Text>
        ) : kind === "pdf" ? (
          <Text variant="body-sm">{fileName || "PDF enviado"}</Text>
        ) : (
          <video className={styles.thumb} src={path} preload="metadata" muted playsInline />
        )}
        <Row gap={2}>
          <label {...button} className={`${button.className} ${styles.upload}`} aria-disabled={progress !== null}>
            <input
              id={id}
              aria-describedby={describedBy}
              type="file"
              className="sr-only"
              accept={
                {
                  image: "image/jpeg,image/png,image/webp",
                  video: "video/mp4,video/webm",
                  captions: ".vtt",
                  pdf: "application/pdf",
                }[kind]
              }
              disabled={progress !== null}
              onChange={(event) => {
                const file = event.target.files?.[0];
                const title = titleField ? event.target.form?.elements.namedItem(titleField) : null;

                event.target.value = "";
                if (file && title instanceof HTMLInputElement && !title.value.trim()) {
                  title.value = formatFileTitle(file.name);
                  title.dispatchEvent(new Event("input", { bubbles: true }));
                }
                if (file) upload(file);
              }}
            />
            {progress !== null ? `Enviando ${progress}%` : path ? "Trocar arquivo" : "Enviar arquivo"}
          </label>
          {path && progress === null ? (
            <button type="button" {...remove} onClick={() => choose("")}>
              Remover
            </button>
          ) : null}
        </Row>
      </Row>
      <Feedback code={code} />
    </Stack>
  );
}

export function Rows({
  rows,
  blank,
  addLabel,
  button,
  icons,
}: {
  rows: ReactNode[];
  blank: ReactNode;
  addLabel: string;
  button: Look;
  icons: { add: ReactNode; remove: ReactNode };
}) {
  const [items, setItems] = useState(() => rows.map((node, id) => ({ id, node })));
  const next = useRef(rows.length);
  const box = useRef<HTMLDivElement>(null);

  function change(update: (current: typeof items) => typeof items) {
    setItems(update);
    // Adding or removing a row is a change the form's unsaved-changes bar must see.
    queueMicrotask(() => box.current?.dispatchEvent(new Event("input", { bubbles: true })));
  }

  return (
    <div ref={box}>
      <Stack gap={2}>
        {items.length ? (
          <ul className={styles.repeat}>
            {items.map((item) => (
              <li className={styles.repeatRow} key={item.id}>
                <div className={styles.repeatBody}>{item.node}</div>
                <button
                  type="button"
                  {...button}
                  data-icon-only
                  aria-label="Remover"
                  title="Remover"
                  onClick={() => change((current) => current.filter((entry) => entry.id !== item.id))}
                >
                  {icons.remove}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div>
          <button
            type="button"
            {...button}
            onClick={() => {
              next.current += 1;
              change((current) => [...current, { id: next.current, node: blank }]);
            }}
          >
            {icons.add}
            {addLabel}
          </button>
        </div>
      </Stack>
    </div>
  );
}

export function TemplateField({
  value = "",
  fields,
  chip,
  children,
}: {
  value?: string;
  fields: { key: string; label: string; sample: string }[];
  chip: Look;
  children: ReactNode;
}) {
  const [text, setText] = useState(value);
  const box = useRef<HTMLDivElement>(null);
  const samples = new Map(fields.map((field): [string, string] => [field.key, field.sample]));
  const preview = text.replace(/\{(\w+)\}/g, (match, key: string) => samples.get(key) ?? match);

  function insert(key: string) {
    const area = box.current?.querySelector("textarea");

    if (!area) return;
    area.value = `${area.value}{${key}}`;
    area.dispatchEvent(new Event("input", { bubbles: true }));
    area.focus();
  }

  return (
    <div
      ref={box}
      onInput={(event) => {
        if (event.target instanceof HTMLTextAreaElement) setText(event.target.value);
      }}
    >
      <Stack gap={2}>
        <Row gap={2}>
          {fields.map((field) => (
            <button key={field.key} type="button" {...chip} onClick={() => insert(field.key)}>
              <Text as="span" variant="caption" mono>{`{${field.key}}`}</Text>
              {field.label}
            </button>
          ))}
        </Row>
        {children}
        <div className={styles.preview}>
          <Text variant="caption" tone="muted">
            Prévia com dados de exemplo
          </Text>
          <Text variant="body-sm">{preview || "A mensagem aparece aqui enquanto você digita."}</Text>
        </div>
      </Stack>
    </div>
  );
}

// The generated secret is shown once, right after it is created: the server never sends it again.
export function WebhookSecret({
  configured,
  button,
  copyIcon,
  copiedIcon,
}: {
  configured: boolean;
  button: Look;
  copyIcon: ReactNode;
  copiedIcon: ReactNode;
}) {
  const [state, action, pending] = useActionState(rotateWebhookSecret, { code: null });

  return (
    <form action={action}>
      <Stack gap={3}>
        {state.secret ? (
          <Stack gap={2}>
            <Text variant="body-sm" weight="semibold">
              Copie o segredo agora: ele não aparece de novo.
            </Text>
            <div className={copyStyles.copyRow}>
              <input className={copyStyles.copyValue} value={state.secret} readOnly aria-label="Segredo do webhook" />
              <CopyButton value={state.secret} copyIcon={copyIcon} copiedIcon={copiedIcon} />
            </div>
          </Stack>
        ) : null}
        <div>
          <SubmitButton {...button}>
            {pending ? "Gerando segredo" : configured ? "Gerar novo segredo" : "Ativar e gerar segredo"}
          </SubmitButton>
        </div>
        <Feedback code={state.code} />
      </Stack>
    </form>
  );
}

// WhatsApp rotates the code about every 40 seconds, so a fresh one is fetched before it expires.
const QR_REFRESH_MS = 30_000;

export function WhatsAppConnect({ retry }: { retry: Look }) {
  const [state, connect, pending] = useActionState(connectWhatsApp, { code: null });

  useEffect(() => {
    startTransition(() => connect());

    const timer = setInterval(() => startTransition(() => connect()), QR_REFRESH_MS);

    return () => clearInterval(timer);
  }, [connect]);

  return (
    <div className={styles.connect}>
      <RefreshWhilePending />
      <div className={styles.qrBox} aria-busy={pending && !state.qr}>
        {state.qr ? (
          <img className={styles.qrImage} src={state.qr} alt="QR Code para conectar o WhatsApp" />
        ) : (
          <span className={styles.qrWaiting}>{state.code ? "Não deu para gerar o código" : "Gerando o QR Code…"}</span>
        )}
      </div>
      <div className={styles.connectSide}>
        <ol className={styles.connectSteps}>
          <li>
            <span>
              No celular do número de vendas, abra o <strong>WhatsApp</strong>.
            </span>
          </li>
          <li>
            <span>
              Toque em <strong>Configurações</strong> e depois em <strong>Aparelhos conectados</strong>.
            </span>
          </li>
          <li>
            <span>
              Toque em <strong>Conectar um aparelho</strong> e aponte a câmera para o código.
            </span>
          </li>
        </ol>
        {state.pairingCode ? (
          <p className={styles.pairing}>
            Sem câmera? Em Conectar um aparelho, toque em <strong>Conectar com número de telefone</strong> e digite{" "}
            <code>{state.pairingCode}</code>
          </p>
        ) : null}
        <p className={styles.qrHint}>O código se renova sozinho. Esta janela fecha quando conectar.</p>
        {state.code ? (
          <>
            <Feedback code={state.code} />
            <button type="button" {...retry} disabled={pending} onClick={() => startTransition(() => connect())}>
              {pending ? "Gerando" : "Tentar de novo"}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
