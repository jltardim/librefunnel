import type { Psp } from "@/lib/orders/psp";

// What each provider calls its keys and where they live in its panel, as the connection screen shows it.
export const PIX_HELP: Record<Psp, { apiKey: string; webhookSecret: string; panel: string; keys: string; webhook: string }> = {
  mercadopago: {
    apiKey: "Access Token de produção",
    webhookSecret: "Assinatura secreta do webhook",
    panel: "https://www.mercadopago.com.br/developers/panel/app",
    keys: "Em Suas integrações > Credenciais de produção, copie o Access Token.",
    webhook: "Em Suas integrações > Webhooks, cole este endereço, marque o evento e copie a assinatura secreta.",
  },
  woovi: {
    apiKey: "AppID",
    webhookSecret: "Authorization do webhook (opcional)",
    panel: "https://app.woovi.com",
    keys: "Em API/Plugins > Nova API/Plugin, escolha API e copie o AppID.",
    webhook: "Em API/Plugins > Novo webhook, crie um webhook com este endereço para cada evento.",
  },
  abacatepay: {
    apiKey: "Chave da API (v2)",
    webhookSecret: "Segredo do webhook (32 caracteres ou mais)",
    panel: "https://app.abacatepay.com",
    keys: "Em Integração > API > Nova chave, escolha API v2 e copie a chave.",
    webhook:
      "Em Integração > Webhooks > Criar webhook (v2), cole este endereço, invente um segredo e marque os eventos.",
  },
  depix: {
    apiKey: "Client Secret",
    webhookSecret: "Segredo do webhook (32 caracteres ou mais)",
    panel: "https://depix.info/#partners",
    keys: "Peça acesso de parceiro à Eulen. No seu canal do Telegram com ela, em #Bot, envie /addclientcredentials librefunnel e copie o Client ID e o Client Secret. O DePix vai para o endereço Liquid padrão da sua conta Eulen.",
    webhook:
      "No mesmo canal, invente um segredo de 32 caracteres ou mais e envie /registerwebhook deposit, este endereço e o segredo, separados por espaço. Repita com med no lugar de deposit.",
  },
  noxpay: {
    apiKey: "API Key",
    webhookSecret: "Webhook Secret",
    panel: "https://noxpay.io",
    keys: "Em Settings > API Keys, crie uma chave e copie a API Key e o Webhook Secret. Não precisa cadastrar webhook: a loja envia o endereço em cada cobrança.",
    webhook: "",
  },
  asaas: {
    apiKey: "Chave da API",
    webhookSecret: "Token do webhook (32 a 255 caracteres)",
    panel: "https://www.asaas.com",
    keys: "Em Integrações > Chaves de API, gere uma chave de produção e copie (ela começa com $aact_prod_). Deixe desligada a emissão de nota fiscal do Asaas: a nota sai pela loja.",
    webhook:
      "Em Integrações > Webhooks > Adicionar, cole este endereço, invente um token de autenticação de 32 caracteres ou mais, escolha a versão 3 da API e marque os eventos de cobrança abaixo.",
  },
};
