# Changelog

O que muda em cada versão da loja. `bun run release` transforma a seção "Próxima versão" na versão publicada, e o texto
dela vira as notas da release no GitHub e no aviso de atualização do painel.

## Próxima versão

- Aula com PDF: anexe um PDF de até 50 MB na aula e o comprador baixa pelo botão Baixar o PDF, com o nome do arquivo que
  você enviou. Só quem tem acesso ao produto baixa; um reembolso tira o acesso ao PDF junto com o das aulas.
- A NFS-e descreve o serviço com o nome do produto vendido, sem o "Acesso ao curso online" na frente.

## v0.10.0 (2026-11-16)

- Atualizar pelo painel traz também a configuração do servidor da versão nova (como a de domínios próprios) e o próprio
  atualizador novo, sem rodar o instalador de novo. Lojas instaladas antes desta versão rodam o instalador uma última
  vez para ganhar isso.
- Mensagens do painel sem nomes de configuração do servidor (ADMIN_PASSWORD, .env, BASE_URL, comandos de terminal).

## v0.9.0 (2026-11-16)

- Vendas enviadas pelo servidor ao TikTok (Events API), ao Google Ads (Data Manager API, com login do Google) e ao
  Google Analytics (compra e reembolso), além da Meta. Página, checkout, Pix gerado e compra contam mesmo quando o
  comprador paga no app do banco e não volta para a página.
- Pixel da Meta, Pixel do TikTok e Google tag no navegador, ligados por padrão e com o mesmo ID de evento do servidor,
  para nada contar em dobro. Rodam só nas páginas de venda, checkout e vitrine.
- Conectar ficou em um passo: cada campo aceita o ID, o código inteiro da tag ou o link da ação de conversão, e Salvar e
  testar já manda um evento de teste e mostra a resposta da plataforma. Cada janela tem os links da página certa de cada
  plataforma.
- Pixel, propriedade do Analytics e ação de conversão por produto, na nova aba Anúncios do produto. Em branco, usa a
  conexão da loja.
- O cartão de cada plataforma em Conexões avisa quantos eventos ela recusou nos últimos 7 dias.
- Verificação de domínio do Google Search Console e da Meta em todos os domínios da loja e dos produtos.
- Link de anúncio com vários IDs de clique (gclid, gbraid, wbraid, fbclid, ttclid) guarda todos, não só o primeiro.
- Logos coloridos oficiais em Conexões.

## v0.8.0 (2026-11-16)

- Domínio próprio por produto, com HTTPS emitido no primeiro acesso só para domínios salvos. A página inicial pode ser a
  vitrine, um produto ou a área de membros.
- Sessões do painel, do comprador e do checkout guardadas no servidor e encerradas de verdade ao sair.
- Página de vendas trata vídeo que não carrega, carregamento lento, botão voltar e visitante que já comprou ou tem Pix
  esperando.

## v0.7.1 (2026-11-15)

- O site mostra os cupons.

## v0.7.0 (2026-11-15)

- Cupons de desconto no checkout.

## v0.6.8 (2026-11-15)

- Dependência node-forge atualizada para a 1.4.3.

## v0.6.7 (2026-11-15)

- Ajustes de layout no site.

## v0.6.6 (2026-11-15)

- Capturas do site com o checkout novo.

## v0.6.5 (2026-11-15)

- Checkout mais curto, com preenchimento automático e validação dos dados centralizada.

## v0.6.4 (2026-11-15)

- Imagem de produção menor: só os ícones usados e sem o banco embutido.

## v0.6.3 (2026-11-15)

- Painel sem rolagem dupla.

## v0.6.2 (2026-11-15)

- Chave Pix da loja e criação de produto em dois passos.

## v0.6.1 (2026-11-15)

- Pedidos em lista com detalhe, editor de produto em seções e barra lateral do painel sempre inteira.

## v0.6.0 (2026-11-15)

- Páginas do comprador mais leves e acompanhamento do funil inteiro no painel.
- Painel de versão mais claro.

## v0.5.0 (2026-11-15)

- Correções de segurança, imagens fixadas por digest e IPv6 no instalador.
- O painel não espera mais pelo atualizador nem pela Evolution parada.

## v0.4.0 (2026-11-15)

- Receber em cripto (DePix, NoxPay e conversão da Woovi) e conciliação de pagamentos.

## v0.3.1 (2026-11-15)

- Instalador no Windows e no macOS.

## v0.3.0 (2026-11-15)

- Primeira versão publicada: instalador de um comando, site com documentação, demonstração e configurações da loja.
