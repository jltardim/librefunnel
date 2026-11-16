import { notFound } from "next/navigation";
import { after } from "next/server";
import type { ReactNode } from "react";
import { Button } from "@/components/action/button";
import { EmptyState } from "@/components/feedback/empty-state";
import { Progress } from "@/components/feedback/progress";
import { Field } from "@/components/form/field";
import { Input } from "@/components/form/input";
import { Icon } from "@/components/media/icon";
import { Card } from "@/components/layout/card";
import { Row } from "@/components/layout/row";
import { Stack } from "@/components/layout/stack";
import { Cover } from "@/components/media/cover";
import { VideoPlayer } from "@/components/media/video-player";
import { Badge } from "@/components/text/badge";
import { Text } from "@/components/text/text";
import { TextLink } from "@/components/text/text-link";
import { settings } from "@/lib/settings";
import type { Module, Product } from "@/lib/catalog/products";
import { completedLessons, currentMember, memberProducts } from "@/lib/members";
import type { Member } from "@/lib/members";
import { streamFor } from "@/lib/media/serving";
import { recordAccess } from "@/lib/tracking/funnel";
import { completeLesson, confirmLogin, requestLogin, signOut } from "@/lib/actions/members";
import { optOut } from "@/lib/actions/messages";
import { Footer, StoreHeader } from "@/app/buyer";
import { ActionForm, FieldMessage, FormMessage, SubmitLabel } from "@/app/ui";
import styles from "./page.module.css";

type Props = {
  params: Promise<{ path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: `Área de membros | ${(await settings()).brand}`, robots: { index: false } };
}

function lessonsOf(product: Product) {
  return product.modules.flatMap((module) => module.lessons.map((lesson) => ({ product, module, lesson })));
}

function Shell({ member, children }: { member?: Member; children: ReactNode }) {
  return (
    <div className={`surface-experience ${styles.page}`}>
      <StoreHeader href={member ? "/m" : "/"}>
        {member ? (
          <Row gap={2} wrap={false}>
            <span className={styles.email} title={member.email}>
              <Text as="span" variant="body-sm" tone="muted">
                {member.email}
              </Text>
            </span>
            <ActionForm action={signOut}>
              <Button type="submit" size="sm">
                <SubmitLabel idle="Sair" pending="Saindo" />
              </Button>
            </ActionForm>
          </Row>
        ) : (
          <Button href="/" size="sm" variant="ghost">
            Ir para a loja
          </Button>
        )}
      </StoreHeader>
      {children}
    </div>
  );
}

function Gate({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Shell>
      <main className={styles.gate}>
        <div className={styles.gateBody}>
          <Stack gap={2}>
            <Text variant="display" as="h1">
              {title}
            </Text>
            {description ? <Text tone="muted">{description}</Text> : null}
          </Stack>
          {children}
        </div>
      </main>
      <Footer />
    </Shell>
  );
}

function Login() {
  return (
    <Gate title="Área de membros">
      <ActionForm action={requestLogin}>
        <Stack gap={4}>
          <Field label="E-mail da compra" hint={<FieldMessage code="INVALID_EMAIL" />}>
            {(control) => (
              <Input
                {...control}
                name="email"
                type="email"
                required
                maxLength={200}
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                inputMode="email"
                placeholder="seu@email.com"
              />
            )}
          </Field>
          <Button type="submit" variant="solid" tone="store" size="lg" block>
            <SubmitLabel idle="Receber link de acesso" pending="Enviando" again="Enviar de novo" />
          </Button>
          <FormMessage done="Se houver compra com este e-mail, o link de acesso chega em instantes." />
        </Stack>
      </ActionForm>
    </Gate>
  );
}

function ConfirmOptOut({ token }: { token: string }) {
  return (
    <Gate title="Parar de receber lembretes" description="Seu acesso aos cursos continua igual.">
      <ActionForm action={optOut} fields={{ token }}>
        <Stack gap={2}>
          <Button type="submit" variant="solid" tone="store" size="lg" block>
            <SubmitLabel idle="Confirmar" pending="Confirmando" />
          </Button>
          <FormMessage done="Pronto, lembretes desligados." />
        </Stack>
      </ActionForm>
    </Gate>
  );
}

function ConfirmLogin({ token }: { token: string }) {
  return (
    <Gate title="Área de membros">
      <ActionForm action={confirmLogin} fields={{ token }}>
        <Stack gap={2}>
          <Button type="submit" variant="solid" tone="store" size="lg" block>
            <SubmitLabel idle="Entrar" pending="Entrando" />
          </Button>
          <FormMessage />
        </Stack>
      </ActionForm>
      <TextLink href="/m">Pedir outro link</TextLink>
    </Gate>
  );
}

function ModuleCover({ product, module, done }: { product: Product; module: Module; done: Set<string> }) {
  const finished = module.lessons.filter((lesson) => done.has(`${product.slug}:${lesson.id}`)).length;
  const target = module.lessons.find((lesson) => !done.has(`${product.slug}:${lesson.id}`)) ?? module.lessons[0];
  if (!target) return null;
  return (
    <Cover
      href={`/m/${product.slug}/${target.id}`}
      title={module.title}
      src={module.cover}
      caption={`${finished} de ${module.lessons.length} ${module.lessons.length === 1 ? "aula" : "aulas"}`}
      progress={Math.round((finished / module.lessons.length) * 100)}
    />
  );
}

function Home({ member, products, done }: { member: Member; products: Product[]; done: Set<string> }) {
  const all = products.flatMap(lessonsOf);
  const finished = all.filter((item) => done.has(`${item.product.slug}:${item.lesson.id}`)).length;
  const next = all.find((item) => !done.has(`${item.product.slug}:${item.lesson.id}`)) ?? all[0];
  const first = products[0];
  const firstName = member.name.split(" ")[0];

  return (
    <Shell member={member}>
      <main className={styles.main}>
        <Stack gap={7}>
          <Stack gap={3}>
            <Text variant="body-sm" tone="muted">
              {firstName ? `Olá, ${firstName}` : "Sua área de membros"}
            </Text>
            <Text variant="display">{products.length === 1 && first ? first.name : "Seus cursos"}</Text>
            {all.length ? (
              <div className={styles.overall}>
                <Stack gap={2}>
                  <Progress value={finished} max={all.length} label="Aulas concluídas" />
                  <Text variant="body-sm" tone="muted">
                    {finished} de {all.length} aulas concluídas
                  </Text>
                </Stack>
              </div>
            ) : null}
            {next ? (
              <Row>
                <Button
                  href={`/m/${next.product.slug}/${next.lesson.id}`}
                  variant="solid"
                  tone="primary"
                  size="lg"
                  icon="play"
                >
                  {finished ? "Continuar assistindo" : "Começar agora"}
                </Button>
              </Row>
            ) : null}
          </Stack>
          {products.length ? (
            products.map((product) => (
              <section key={product.slug}>
                <Stack gap={3}>
                  <Text variant="heading" as="h2">
                    {product.name}
                  </Text>
                  {product.modules.length ? (
                    <div className={styles.shelf}>
                      {product.modules.map((module) => (
                        <ModuleCover key={module.id} product={product} module={module} done={done} />
                      ))}
                    </div>
                  ) : (
                    <EmptyState
                      title="Aulas a caminho"
                      description="As aulas deste produto ainda não foram publicadas. Assim que saírem, aparecem aqui."
                    />
                  )}
                </Stack>
              </section>
            ))
          ) : (
            <EmptyState
              title={`Nenhum produto liberado para ${member.email}`}
              description="Comprou com outro e-mail? Toque em Sair e entre com ele. Pagou agora? A liberação aparece aqui assim que o Pix for confirmado."
            />
          )}
          {member.scope === "order" ? (
            <ActionForm action={requestLogin} fields={{ email: member.email }}>
              <Stack gap={2}>
                <Row gap={2}>
                  <Text variant="body-sm" tone="muted">
                    Para entrar de outros aparelhos:
                  </Text>
                  <Button type="submit" variant="ghost" size="sm" icon="mail">
                    <SubmitLabel idle="receber o link por e-mail" pending="Enviando" />
                  </Button>
                </Row>
                <FormMessage done={`O link chega em instantes em ${member.email} e vale por 1 hora.`} />
              </Stack>
            </ActionForm>
          ) : null}
        </Stack>
      </main>
    </Shell>
  );
}

async function Lesson({
  member,
  product,
  lessonId,
  done,
}: {
  member: Member;
  product: Product;
  lessonId: string;
  done: Set<string>;
}) {
  const all = lessonsOf(product);
  const index = all.findIndex((item) => item.lesson.id === lessonId);
  const current = all[index];
  if (!current) notFound();
  const next = all[index + 1];
  const { module, lesson } = current;
  const isDone = done.has(`${product.slug}:${lesson.id}`);
  const stream = lesson.video ? await streamFor(lesson.video) : undefined;

  return (
    <Shell member={member}>
      <main className={styles.lesson}>
        <div className={styles.lessonMain}>
          <Stack gap={5}>
            <Row>
              <Button href="/m" variant="ghost" size="sm" icon="arrow-left">
                Todos os cursos
              </Button>
            </Row>
            {lesson.video ? (
              <VideoPlayer src={lesson.video} stream={stream} title={lesson.title} watermark={member.email} />
            ) : null}
            <Stack gap={1}>
              <Text variant="body-sm" tone="muted">
                {product.name} · {module.title}
              </Text>
              <Text variant="heading" as="h1">
                {lesson.title}
              </Text>
            </Stack>
            {lesson.text ? (
              <Card title={lesson.video ? undefined : "Aula de leitura"}>
                <Stack gap={3}>
                  {lesson.text
                    .split("\n")
                    .filter((line) => line.trim())
                    .map((line, position) => (
                      <Text key={position}>{line}</Text>
                    ))}
                </Stack>
              </Card>
            ) : null}
            {lesson.attachment ? (
              <Row>
                <Button href={`/m/${product.slug}/${lesson.id}/anexo`} variant="solid" tone="primary" icon="download">
                  Baixar o PDF
                </Button>
              </Row>
            ) : null}
            <Row gap={3}>
              {isDone ? (
                <Badge tone="success">Aula concluída</Badge>
              ) : (
                <ActionForm action={completeLesson} fields={{ product: product.slug, lesson: lesson.id }}>
                  <Stack gap={2}>
                    <Button type="submit" variant="solid" tone="primary" icon="check">
                      <SubmitLabel idle="Marcar como concluída" pending="Salvando" />
                    </Button>
                    <FormMessage done="Aula concluída." />
                  </Stack>
                </ActionForm>
              )}
              {next ? (
                <Button href={`/m/${product.slug}/${next.lesson.id}`} icon="arrow-right">
                  Próxima aula
                </Button>
              ) : (
                <Button href="/m">Voltar aos cursos</Button>
              )}
            </Row>
          </Stack>
        </div>
        <nav className={styles.lessonList} aria-label={`Aulas de ${product.name}`}>
          <Stack gap={5}>
            {product.modules.map((item) => (
              <Stack gap={2} key={item.id}>
                <Text variant="body-sm" as="h2" weight="semibold">
                  {item.title}
                </Text>
                <ol className={styles.lessons}>
                  {item.lessons.map((entry) => {
                    const entryDone = done.has(`${product.slug}:${entry.id}`);
                    return (
                      <li key={entry.id}>
                        <a
                          href={`/m/${product.slug}/${entry.id}`}
                          className={styles.lessonLink}
                          aria-current={entry.id === lesson.id ? "page" : undefined}
                        >
                          <span className={styles.mark} data-done={entryDone}>
                            {entryDone ? <Icon name="check" size={16} label="Concluída" /> : null}
                          </span>
                          <Text as="span" variant="body-sm">
                            {entry.title}
                          </Text>
                        </a>
                      </li>
                    );
                  })}
                </ol>
              </Stack>
            ))}
          </Stack>
        </nav>
      </main>
    </Shell>
  );
}

export default async function Members({ params, searchParams }: Props) {
  const { path = [] } = await params;
  if (path.length !== 0 && path.length !== 2) notFound();
  const { t, unsubscribe } = await searchParams;
  if (typeof unsubscribe === "string") return <ConfirmOptOut token={unsubscribe} />;
  if (typeof t === "string") return <ConfirmLogin token={t} />;

  const member = await currentMember();
  if (!member) return <Login />;
  const [products, done] = await Promise.all([memberProducts(member), completedLessons(member)]);
  after(() => recordAccess(products.map((product) => product.slug)));
  const [productSlug, lessonId] = path;

  if (productSlug && lessonId) {
    const product = products.find((item) => item.slug === productSlug);
    if (!product) notFound();
    return <Lesson member={member} product={product} lessonId={lessonId} done={done} />;
  }
  return <Home member={member} products={products} done={done} />;
}
