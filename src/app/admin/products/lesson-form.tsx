import { Field } from "@/components/form/field";
import { Textarea } from "@/components/form/textarea";
import { saveLesson } from "@/lib/actions/products";
import type { Module } from "@/lib/catalog/products";
import { PRIMARY, TextField } from "../shared";
import { SaveForm } from "../ui";
import { MediaField } from "./media-field";

export function LessonForm({ module, lesson }: { module?: number; lesson?: Module["lessons"][number] }) {
  return (
    <SaveForm
      action={saveLesson}
      label={lesson ? "Salvar aula" : "Adicionar aula"}
      pendingLabel={lesson ? "Salvando" : "Adicionando"}
      done={lesson ? "Aula salva." : "Aula adicionada. Crie outra ou feche esta janela."}
      reset={!lesson}
      button={PRIMARY}
    >
      {lesson ? (
        <input type="hidden" name="lesson" value={lesson.id} />
      ) : (
        <input type="hidden" name="module" value={module} />
      )}
      <TextField
        label="Título da aula"
        name="title"
        required
        maxLength={120}
        defaultValue={lesson?.title}
        placeholder="Boas-vindas"
      />
      <MediaField name="video" kind="video" label="Vídeo da aula" value={lesson?.video} titleField="title" />
      <Field label="Texto da aula" hint="Sem vídeo, a aula vira uma aula de leitura.">
        {(control) => <Textarea {...control} name="text" rows={6} maxLength={20000} defaultValue={lesson?.text} />}
      </Field>
      <MediaField
        name="attachment"
        kind="pdf"
        label="PDF da aula"
        value={lesson?.attachment ?? undefined}
        originalName={{ field: "attachmentName", value: lesson?.attachmentName ?? undefined }}
      />
    </SaveForm>
  );
}
