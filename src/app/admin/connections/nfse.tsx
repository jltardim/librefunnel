import { Field } from "@/components/form/field";
import { Input } from "@/components/form/input";
import { Select } from "@/components/form/select";
import { Disclosure } from "@/components/layout/disclosure";
import { Dialog } from "@/components/overlay/dialog";
import { saveNfse } from "@/lib/actions/connections";
import type { Regime } from "@/lib/invoices";
import { PRIMARY, TextField, type Links } from "../shared";
import { SaveForm } from "../ui";
import styles from "./connections.module.css";
import { configured, Integration, RemoveButton, SecretInput, TestButton } from "./parts";
import { formatDocument } from "@/format";

const DATE = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo" });

const REGIMES: Record<Regime, string> = { mei: "MEI", simples: "Simples Nacional", normal: "Lucro Presumido ou Real" };

const IMMUNITY_OPTIONS = [
  { value: "", label: "Nenhuma: serviço com ISS" },
  { value: "livros", label: "Livro ou e-book (CF, art. 150, VI, d)" },
];

const REGIME_OPTIONS = [
  { value: "", label: "Pelo CNPJ" },
  ...Object.entries(REGIMES).map(([value, label]) => ({ value, label })),
];

export function Nfse({ nfse }: { nfse: Links["nfse"] }) {
  return (
    <Integration
      brand="nfse"
      name="Nota fiscal"
      description={
        nfse.configured
          ? `${nfse.holder} (${formatDocument(nfse.cnpj)}), ${nfse.regime ? REGIMES[nfse.regime] : ""}${nfse.place ? ` em ${nfse.place}` : ""}${nfse.immunity ? ", imune ao ISS (livro)" : ""}. Certificado vence em ${nfse.expiresAt ? DATE.format(nfse.expiresAt) : "data desconhecida"}.`
          : "Emite a NFS-e Nacional de cada venda paga e cancela no reembolso."
      }
      status={configured(nfse.configured)}
    >
      <Dialog
        trigger={{ label: nfse.configured ? "Configurar" : "Conectar", size: "sm" }}
        title="Nota fiscal (NFS-e Nacional)"
        body={
          <SaveForm
            action={saveNfse}
            label={nfse.configured ? "Salvar e testar" : "Conectar"}
            pendingLabel="Conectando com o gov.br"
            done="Nota fiscal ligada. Cada venda paga a partir de agora recebe nota."
            button={PRIMARY}
          >
            <Field label="Certificado A1 da empresa (.pfx ou .p12)">
              {(control) => (
                <Input {...control} name="certificate" type="file" accept=".pfx,.p12,application/x-pkcs12" />
              )}
            </Field>
            <SecretInput
              name="password"
              label="Senha do certificado"
              set={false}
              hint={nfse.configured ? "Só se enviar um certificado novo." : undefined}
            />
            <Disclosure label="Ajustar dados fiscais">
              <Field label="Regime">
                {(control) => (
                  <Select {...control} name="regime" defaultValue={nfse.regime ?? ""} options={REGIME_OPTIONS} />
                )}
              </Field>
              <div className={styles.pair}>
                <TextField
                  label="Código IBGE do município"
                  name="city"
                  inputMode="numeric"
                  maxLength={7}
                  defaultValue={nfse.city}
                  placeholder="Pelo CNPJ"
                />
                <TextField
                  label="Inscrição municipal"
                  name="registration"
                  defaultValue={nfse.registration}
                  hint="Em branco se a empresa não tem."
                />
              </div>
              <TextField
                label="Código de tributação nacional"
                name="service"
                inputMode="numeric"
                maxLength={8}
                defaultValue={nfse.service}
                placeholder="080201"
                hint="080201 é treinamento e ensino. Confirme com o seu contador."
              />
              <Field
                label="Imunidade do ISS"
                hint="Livro e e-book não pagam ISS. Use com o código 010902 e avise o contador para separar essa receita."
              >
                {(control) => (
                  <Select {...control} name="immunity" defaultValue={nfse.immunity} options={IMMUNITY_OPTIONS} />
                )}
              </Field>
              <div className={styles.pair}>
                <TextField
                  label="Tributos aproximados (%)"
                  name="taxRate"
                  inputMode="decimal"
                  defaultValue={nfse.taxRate}
                  placeholder="Padrão do regime"
                  hint="Simples: alíquota efetiva do DAS (padrão 6). Presumido ou Real: tributos federais (padrão 11,33)."
                />
                <TextField
                  label="ISS (%)"
                  name="issRate"
                  inputMode="decimal"
                  defaultValue={nfse.issRate}
                  placeholder="5"
                  hint="Só Presumido ou Real."
                />
              </div>
            </Disclosure>
          </SaveForm>
        }
      />
      {nfse.configured ? (
        <>
          <TestButton kind="nfse" />
          <RemoveButton
            kind="nfse"
            warning="As próximas vendas deixam de receber nota. Notas já emitidas continuam válidas, e um reembolso não cancela mais a nota sozinho."
          />
        </>
      ) : null}
    </Integration>
  );
}
