import { CopyField } from "@/components/action/copy-field";
import { Field } from "@/components/form/field";
import { Select } from "@/components/form/select";
import { BrandLogo } from "@/components/media/brand-logo";
import { Dialog } from "@/components/overlay/dialog";
import { Badge } from "@/components/text/badge";
import { savePix, savePixKey } from "@/lib/actions/connections";
import { NOXPAY_CURRENCIES } from "@/lib/orders/psp";
import type { ReactNode } from "react";
import { OUTLINE, PRIMARY, TextField, type Links } from "../shared";
import { ActionButton, SaveForm } from "../ui";
import styles from "./connections.module.css";
import { PixFields } from "../products/pix-fields";
import { RemoveButton, SecretInput, Steps, TestButton } from "./parts";
import { PIX_HELP } from "./pix-help";

type Provider = Links["pix"]["providers"][number];
type Paid = Exclude<Provider["id"], "static">;


function Setup({ provider, help }: { provider: Provider; help: (typeof PIX_HELP)[Paid] }) {
  return (
    <Steps>
      <li>
        <p>
          <strong>Pegue a chave.</strong>{" "}
          <a href={help.panel} target="_blank" rel="noopener noreferrer">
            Abra o painel de {provider.name}
          </a>
          . {help.keys}
        </p>
      </li>
      {provider.webhookUrl ? (
        <li>
          <p>
            <strong>Cadastre o webhook.</strong> {help.webhook}
          </p>
          <CopyField label="Endereço do webhook" value={provider.webhookUrl} />
          {provider.events.length ? (
            <span className={styles.events}>
              {provider.events.map((event) => (
                <Badge key={event}>{event}</Badge>
              ))}
            </span>
          ) : null}
        </li>
      ) : null}
      <li>
        <strong>Cole as chaves aqui.</strong>
        <SaveForm
          action={savePix}
          label={provider.active ? "Salvar chaves" : "Salvar e usar este provedor"}
          pendingLabel="Salvando"
          done="Salvo. Clique em Testar."
          button={PRIMARY}
        >
          <input type="hidden" name="provider" value={provider.id} />
          {provider.id === "depix" ? (
            <TextField label="Client ID" name="clientId" autoComplete="off" defaultValue={provider.clientId} />
          ) : null}
          {provider.id === "noxpay" ? (
            <Field label="Moeda que você recebe">
              {(control) => (
                <Select
                  {...control}
                  name="currency"
                  defaultValue={provider.currency || NOXPAY_CURRENCIES[0].code}
                  options={NOXPAY_CURRENCIES.map((currency) => ({ value: currency.code, label: currency.label }))}
                />
              )}
            </Field>
          ) : null}
          <SecretInput name="apiKey" label={help.apiKey} set={provider.apiKeySet} />
          <SecretInput name="webhookSecret" label={help.webhookSecret} set={provider.webhookSecretSet} />
        </SaveForm>
      </li>
    </Steps>
  );
}

export function PixKeyForm({ pix }: { pix?: Links["pix"]["account"] }) {
  return (
    <SaveForm action={savePixKey} label="Salvar chave" pendingLabel="Salvando" done="Chave salva." button={PRIMARY}>
      <PixFields pix={pix ?? undefined} />
    </SaveForm>
  );
}

function ProviderTile({ provider, account }: { provider: Provider; account: Links["pix"]["account"] }) {
  return (
    <div className={styles.tile} data-active={provider.active}>
      <div className={styles.tileHead}>
        <BrandLogo brand={provider.id === "static" ? "pix" : provider.id} />
        {provider.active ? <Badge tone="success">Em uso</Badge> : null}
      </div>
      <strong>{provider.id === "static" ? "Pix na sua chave" : provider.name}</strong>
      <span className={styles.description}>
        {provider.id === "static" && account
          ? `Cai em ${account.key}. Sem taxa: você libera cada pedido ao ver o valor no extrato.`
          : `${provider.fee} ${provider.needsCnpj ? "Exige CNPJ (MEI serve)." : "Funciona com CPF."}`}
      </span>
      <div className={styles.tileActions}>
        {provider.id === "static" ? (
          <>
            <Dialog
              trigger={{ label: account ? "Trocar chave" : "Cadastrar chave", size: "sm" }}
              title="Chave Pix da loja"
              description="Vale para todos os produtos. Com um provedor conectado, é a chave de reserva."
              body={<PixKeyForm pix={account} />}
            />
            {provider.active || !account ? null : (
              <ActionButton
                action={savePix}
                fields={{ provider: "static" }}
                button={OUTLINE}
                label="Usar"
                pendingLabel="Salvando"
                done="Pronto: os próximos pedidos usam o Pix na chave da loja."
              />
            )}
          </>
        ) : (
          <>
            <Dialog
              trigger={{ label: provider.configured ? "Configurar" : "Conectar", size: "sm" }}
              title={`Conectar ${provider.name}`}
              body={<Setup provider={provider} help={PIX_HELP[provider.id]} />}
            />
            {provider.configured ? (
              <>
                <TestButton kind={provider.id} />
                <RemoveButton
                  kind={provider.id}
                  warning="Pedidos já gerados por este provedor deixam de ser confirmados sozinhos: libere-os em Pedidos."
                />
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

export function PixProviders({
  providers,
  account,
  children,
}: {
  providers: Provider[];
  account: Links["pix"]["account"];
  children?: ReactNode;
}) {
  return (
    <div className={styles.tiles}>
      {providers.map((provider) => (
        <ProviderTile key={provider.id} provider={provider} account={account} />
      ))}
      {children}
    </div>
  );
}
