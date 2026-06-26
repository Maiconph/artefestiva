import { setGlobalOptions } from "firebase-functions";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as admin from "firebase-admin";
import { google } from "googleapis";
import * as path from "path";

// Inicializa o painel de controle com privilégios de administrador (Backend)
admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({ maxInstances: 10 });

// ==========================================
// SESSÃO: GERAÇÃO DE COBRANÇA ASAAS (PIX)
// ==========================================
export const gerarPagamentoPix = onRequest({ cors: true }, async (req, res) => {
  try {
    const { nome, cpf, valor, idLocacao } = req.body;

    if (!nome || !valor || !idLocacao) {
      res.status(400).send({ error: "Payload inválido. Faltam dados críticos." });
      return;
    }

    // Busca a API Key dinâmica salva no painel
    const asaasConfigSnap = await db.doc('configuracoes/asaas').get();
    const asaasConfig = asaasConfigSnap.data();

    if (!asaasConfig || !asaasConfig.apiKey) {
      throw new Error("Gateway de pagamento não configurado. API Key ausente.");
    }

    const ASAAS_API_KEY = asaasConfig.apiKey; 
    const ASAAS_URL = "https://api.asaas.com/v3"; 

    // Função auxiliar blindada para comunicar com o Asaas
    const fetchAsaasSeguro = async (endpoint: string, method: string, body?: any) => {
      const response = await fetch(`${ASAAS_URL}${endpoint}`, {
        method,
        headers: { 
          'Content-Type': 'application/json', 
          'access_token': ASAAS_API_KEY,
          'User-Agent': 'ArteFestivaApp/1.0' // Evita bloqueio do firewall do Asaas
        },
        body: body ? JSON.stringify(body) : undefined
      });
      
      const text = await response.text(); // Pega a resposta bruta primeiro
      
      if (!response.ok) {
        console.error(`🔴 Asaas recusou [${endpoint}]. Status: ${response.status}. Motivo:`, text);
        throw new Error(`Gateway Asaas recusou a requisição (HTTP ${response.status})`);
      }
      
      return text ? JSON.parse(text) : {};
    };

    // 1. Criar o Cliente Oculto no Asaas
    const clienteAsaas = await fetchAsaasSeguro('/customers', 'POST', { name: nome, cpfCnpj: cpf || '' });

    if (!clienteAsaas.id) {
        throw new Error("Falha lógica: Asaas não retornou o ID do cliente.");
    }

    // 2. Gerar a Cobrança Dinâmica atrelada à locação
    const cobranca = await fetchAsaasSeguro('/payments', 'POST', {
        customer: clienteAsaas.id,
        billingType: "PIX",
        value: valor,
        dueDate: new Date().toISOString().split('T')[0],
        description: `Sinal de Locação Ateliê - Ref: ${idLocacao}`,
        externalReference: idLocacao
    });

    if (!cobranca.id) {
        throw new Error("Falha lógica: Asaas não retornou o ID da cobrança.");
    }

    // 3. Resgatar a Imagem (Base64) e o Payload (Copia e Cola)
    const qrCodeData = await fetchAsaasSeguro(`/payments/${cobranca.id}/pixQrCode`, 'GET');

    res.status(200).send({
      sucesso: true,
      qrCodeBase64: qrCodeData.encodedImage,
      copiaECola: qrCodeData.payload
    });

  } catch (error: any) {
    console.error("Falha no pipeline de geração Pix:", error.message || error);
    res.status(500).send({ error: "Falha técnica na comunicação com o Gateway Asaas." });
  }
});

// ==========================================
// SESSÃO: WEBHOOK DE RETORNO DO ASAAS
// ==========================================
export const webhookAsaas = onRequest({ cors: true }, async (req, res) => {
  try {
    // Parser de segurança agressivo: se o corpo chegar como string, força a conversão para objeto
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    
    const eventoAsaas = body?.event; // Ex: PAYMENT_RECEIVED, PAYMENT_CONFIRMED
    const pagamento = body?.payment;

    // Ping de validação ou Handshake inicial do painel do Asaas
    if (!pagamento) {
      res.status(200).send("Webhook de Escuta Ativo");
      return;
    }

    // Recupera a âncora da nossa locação salva no momento da geração da cobrança
    const idLocacao = pagamento.externalReference;

    if (!idLocacao) {
      res.status(400).send("Operação Abortada: Pagamento sem externalReference.");
      return;
    }

    // Filtro de Segurança: Só atua se o dinheiro realmente compensou na conta
    if (eventoAsaas === 'PAYMENT_RECEIVED' || eventoAsaas === 'PAYMENT_CONFIRMED') {
      const locacaoRef = db.collection('locacoes').doc(idLocacao);
      const locacaoSnap = await locacaoRef.get();

      if (!locacaoSnap.exists) {
         res.status(404).send("Falha: Registro de locação não encontrado no Firestore.");
         return;
      }

      const dadosLocacao = locacaoSnap.data();
      const statusAtual = dadosLocacao?.['status'];
      const valorPagoAsaas = Number(pagamento.value || 0);
      const valorPendenteAtual = Number(dadosLocacao?.['valorPendente'] || 0);

      // Matemática Contábil Blindada contra NaN
      const novoValorPendente = Math.max(0, valorPendenteAtual - valorPagoAsaas);
      const novoStatus = novoValorPendente === 0 ? 'pago' : 'pago_parcialmente';

      // Separação lógica: se já estava pago parcialmente, é acerto final. Se não, é sinal/reserva.
      const ehAcertoFinal = statusAtual === 'pago_parcialmente';
      const novoSinalPago = Number(dadosLocacao?.['valorSinalPago'] || 0) + (ehAcertoFinal ? 0 : valorPagoAsaas);
      const novoAcertoFinal = Number(dadosLocacao?.['valorAcertoFinal'] || 0) + (ehAcertoFinal ? valorPagoAsaas : 0);

      // Execução Admin SDK com tipagem e campos distribuídos corretamente
      await locacaoRef.update({
        status: novoStatus,
        valorPendente: novoValorPendente,
        valorSinalPago: novoSinalPago,
        valorAcertoFinal: novoAcertoFinal
      });

      console.log(`Sucesso Contábil: Locação ${idLocacao} atualizada com sucesso para o status ${novoStatus}.`);
    }

    res.status(200).send("Processamento Finalizado.");
  } catch (error) {
    console.error("Falha técnica no processamento do Webhook:", error);
    res.status(500).send("Erro interno de servidor.");
  }
});

export const limparReservasAbandonadas = onSchedule({
  schedule: "every 30 minutes",
  timeZone: "America/Sao_Paulo",
  retryCount: 3
}, async (event) => {
  try {
    // Tolerância de 24 horas (tempo que o cliente tem para fechar negócio antes de perder a reserva do bolo)
    const tempoLimite = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Busca documentos que estão segurando a agenda indevidamente (Abandono de checkout ou ghosting de orçamento)
    const locacoesRef = db.collection('locacoes');
    const snapshot = await locacoesRef
      .where('status', 'in', ['pendente_pagamento', 'orcamento_enviado'])
      .where('dataCriacao', '<', tempoLimite)
      .get();

    if (snapshot.empty) {
      console.log("Infra: Nenhuma reserva abandonada encontrada nesta varredura.");
      return;
    }

    // Operação em Lote (Batch) para performance agressiva e economia de gravações (Writes)
    const batch = db.batch();
    let contador = 0;

    snapshot.docs.forEach((doc) => {
      batch.update(doc.ref, {
        status: 'cancelado',
        motivoCancelamento: 'Sistema: Timeout de pagamento ou expiração do orçamento (24h).',
        dataCancelamento: new Date()
      });
      contador++;
    });

    await batch.commit();
    console.log(`Operação Cirúrgica: ${contador} locações fantasmas canceladas. Estoque liberado com sucesso.`);

  } catch (error) {
    console.error("Falha técnica ao executar a varredura do Cron Job:", error);
  }
});

// ==========================================
// SESSÃO: ORQUESTRADOR WHATSAPP E PDF
// ==========================================
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
const PDFDocument = require('pdfkit');

// Utilitário interno para higienizar números de telefone para a Evolution
function higienizarNumero(numero: string): string {
  if (!numero) return '';
  let limpo = numero.replace(/\D/g, '');
  if (!limpo.startsWith('55')) limpo = `55${limpo}`;
  return limpo;
}

// Disparador Universal HTTP para a Evolution API
async function dispararEvolution(urlApi: string, apiKey: string, endpoint: 'sendText' | 'sendMedia', payload: any) {
  try {
    const res = await fetch(`${urlApi}/message/${endpoint}/arte_festiva`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
      body: JSON.stringify({ ...payload, options: { delay: 1500, presence: 'composing' } })
    });
    return await res.json();
  } catch (error) {
    console.error(`Falha no disparo Evolution API (${endpoint}):`, error);
    return null;
  }
}

// A função fixarMensagemEvolution foi removida pois a Evolution API ainda não possui rota REST nativa para Pin de Mensagem.

export const orquestradorWhatsapp = onDocumentUpdated("locacoes/{id}", async (event) => {
  const before = event.data?.before.data();
  const after = event.data?.after.data();
  if (!before || !after) return;

  // 1. Resgata Credenciais do Painel de Controle (Evita hardcode)
  const configSnap = await db.doc('configuracoes/whatsapp').get();
  if (!configSnap.exists) return;
  
  const config = configSnap.data();
  if (!config?.urlApi || !config?.apiKey) return;

  const { urlApi, apiKey } = config;
  const numCliente = higienizarNumero(after.cliente?.whatsapp);
  const adminPgto1 = higienizarNumero(config.numeroNotificacaoPagamento);
  const adminPgto2 = higienizarNumero(config.numeroNotificacaoPagamento2);
  const adminAssinatura1 = higienizarNumero(config.numeroNotificacaoAssinatura);
  const adminAssinatura2 = higienizarNumero(config.numeroNotificacaoAssinatura2);
  const motorista = higienizarNumero(config.numeroEntregador);

  // Adaptador de Compatibilidade Multi-Bolo (Garante que contratos antigos e novos funcionem perfeitamente)
  const nomesBolosStr = after.bolos && after.bolos.length > 0 
    ? after.bolos.map((b: any) => b.nomeBolo || b.nome).join(', ') 
    : after.nomeBolo;

  // ==========================================
  // CENÁRIO 1: ORÇAMENTO ENVIADO (PDF + PIX DIRETO NO WHATSAPP)
  // ==========================================
  if (before.status !== 'orcamento_enviado' && after.status === 'orcamento_enviado') {
    if (!numCliente) return;

    try {
      // 1. Resgata a chave do Asaas para gerar a cobrança
      const asaasSnap = await db.doc('configuracoes/asaas').get();
      const asaasKey = asaasSnap.data()?.apiKey;

      if (!asaasKey) throw new Error("Chave do Asaas não configurada.");

      const fetchAsaas = async (endpoint: string, method: string, body?: any) => {
        const res = await fetch(`https://api.asaas.com/v3${endpoint}`, {
          method,
          headers: { 'Content-Type': 'application/json', 'access_token': asaasKey, 'User-Agent': 'ArteFestivaApp/1.0' },
          body: body ? JSON.stringify(body) : undefined
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`Asaas recusou: ${text}`);
        return text ? JSON.parse(text) : {};
      };

      // 2. Gera a cobrança dinamicamente no Asaas (Cria Cliente -> Cria Fatura -> Pega QR Code)
      const clienteAsaas = await fetchAsaas('/customers', 'POST', { name: after.cliente.nome, cpfCnpj: after.cliente.cpf || '' });
      
      const valorSinal = after.valorSinalAcordado || (after.valorTotalAcordado / 2);
      
      const cobranca = await fetchAsaas('/payments', 'POST', {
        customer: clienteAsaas.id,
        billingType: "PIX",
        value: valorSinal,
        dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0], // Expira em 24h
        description: `Sinal de Locação Ateliê - Ref: ${after.codigoReserva || event.params.id}`,
        externalReference: event.params.id
      });

      const qrCodeData = await fetchAsaas(`/payments/${cobranca.id}/pixQrCode`, 'GET');

      // 3. Dispara as mensagens em sequência para o WhatsApp da Cliente

      // A) Envia o PDF do Orçamento
      const pdfBase64 = await gerarPdfOrcamentoBase64(after, event.params.id);
      await dispararEvolution(urlApi, apiKey, 'sendMedia', {
        number: numCliente,
        mediatype: 'document',
        fileName: `Orcamento_ArteFestiva_${after.codigoReserva || '001'}.pdf`,
        media: pdfBase64
      });

      // B) Envia o Texto Explicativo (Sem link externo)
      const textoCliente = `Olá *${after.cliente.nome.split(' ')[0]}*!\n\nSeu orçamento para a(s) peça(s) *${nomesBolosStr}* foi gerado com sucesso! 🎂\n\n📄 O documento em PDF acima contém todos os detalhes, valores e a logística escolhida.\n\n⚠️ *ATENÇÃO:* Você tem uma tolerância máxima de *24 horas* para confirmar a reserva efetuando o pagamento do sinal de *R$ ${valorSinal.toFixed(2)}*. Após esse prazo, o(s) item(ns) retorna(m) automaticamente para a vitrine do ateliê.\n\nPara garantir sua data, realize o pagamento via PIX através do QR Code abaixo ou copiando a chave:`;
      
      await dispararEvolution(urlApi, apiKey, 'sendText', {
        number: numCliente,
        text: textoCliente
      });

      // C) Envia a Imagem do QR Code
      await dispararEvolution(urlApi, apiKey, 'sendMedia', {
        number: numCliente,
        mediatype: 'image',
        fileName: 'qrcode_pix.png',
        media: qrCodeData.encodedImage
      });

      // D) Envia APENAS a string do Copia e Cola em uma mensagem isolada (Fácil de copiar)
      await dispararEvolution(urlApi, apiKey, 'sendText', {
        number: numCliente,
        text: qrCodeData.payload
      });

    } catch (error) {
      console.error("Falha ao gerar cobrança direta via WhatsApp:", error);
      // Fallback de Segurança: Se a API do Asaas cair, a cliente recebe o PDF e a Gê negocia o Pix manual
      const pdfBase64 = await gerarPdfOrcamentoBase64(after, event.params.id);
      await dispararEvolution(urlApi, apiKey, 'sendMedia', {
        number: numCliente,
        mediatype: 'document',
        fileName: `Orcamento_ArteFestiva_${after.codigoReserva || '001'}.pdf`,
        media: pdfBase64
      });
      await dispararEvolution(urlApi, apiKey, 'sendText', {
        number: numCliente,
        text: `Olá *${after.cliente.nome.split(' ')[0]}*. Seu orçamento está no PDF acima! Tivemos uma pequena instabilidade para gerar sua chave PIX automática. Por favor, nos chame aqui no WhatsApp para finalizarmos sua reserva e segurarmos sua data!`
      });
    }
  }

  // ==========================================
  // CENÁRIO 2: PAGAMENTO CONFIRMADO
  // ==========================================
  const pagouAgora = (after.status === 'pago' || after.status === 'pago_parcialmente') &&
                     (before.status !== 'pago' && before.status !== 'pago_parcialmente');

  if (pagouAgora) {
    const sinalPago = (after.valorSinalPago || 0).toFixed(2);
    const pendente = (after.valorPendente || 0).toFixed(2);

    // Feedback Imediato para o Cliente
    if (numCliente) {
      const msgFeedback = `✅ *Pagamento Confirmado!*\n\nOlá *${after.cliente.nome.split(' ')[0]}*, recebemos o seu pagamento de R$ ${sinalPago} referente à reserva de: *${nomesBolosStr}*.\n\nSua locação está 100% garantida para o dia ${after.dataEvento.split('-').reverse().join('/')}!\n\nAgora só falta assinar o contrato digital para finalizarmos os trâmites legais:\n🔗 https://arte-festiva-atelie.web.app/assinatura/${event.params.id}`;
      await dispararEvolution(urlApi, apiKey, 'sendText', { number: numCliente, text: msgFeedback });
    }

    // Feedback Imediato para as Administradoras (Gê)
    const msgAdminPgto = `💰 *NOVO PAGAMENTO RECEBIDO!*\n\n*Cliente:* ${after.cliente.nome}\n*Peça(s):* ${nomesBolosStr}\n*Protocolo:* ${after.codigoReserva || 'N/A'}\n\n*Valor Recebido (Pix):* R$ ${sinalPago}\n*Saldo Restante:* R$ ${pendente}\n*Status Atual:* ${after.status === 'pago' ? 'Quitado' : 'Parcial (Sinal)'}\n\nAguardando cliente realizar a assinatura do contrato.`;
    
    if (adminPgto1) await dispararEvolution(urlApi, apiKey, 'sendText', { number: adminPgto1, text: msgAdminPgto });
    if (adminPgto2) await dispararEvolution(urlApi, apiKey, 'sendText', { number: adminPgto2, text: msgAdminPgto });
  }

  // ==========================================
  // CENÁRIO 3: ASSINATURA DE CONTRATO FINALIZADA
  // ==========================================
  if (before.status !== 'contrato_assinado' && after.status === 'contrato_assinado') {
    // Renderiza o PDF do contrato assinado utilizando o motor em memória
    const pdfAssinadoBase64 = await gerarPdfContratoAssinadoBase64(after, event.params.id);

    // 1. Disparo do PDF e confirmação para o Cliente
    if (numCliente) {
      await dispararEvolution(urlApi, apiKey, 'sendMedia', {
        number: numCliente,
        mediatype: 'document',
        fileName: `Contrato_Assinado_ArteFestiva_${after.codigoReserva || '001'}.pdf`,
        media: pdfAssinadoBase64
      });
      
      const msgClienteAssinatura = `✅ *Contrato Assinado com Sucesso!*\n\nOlá *${after.cliente.nome.split(' ')[0]}*, recebemos a sua assinatura digital.\n\nSegue acima a sua via do contrato em PDF para os seus registros. Agradecemos a confiança!`;
      await dispararEvolution(urlApi, apiKey, 'sendText', { number: numCliente, text: msgClienteAssinatura });
    }

    // 2. Disparo do PDF e aviso para a Administração
    const msgAdminAssinatura = `✍️ *NOVO CONTRATO ASSINADO!*\n\n*Cliente:* ${after.cliente.nome}\n*Peça(s):* ${nomesBolosStr}\n*Protocolo:* ${after.codigoReserva || 'N/A'}\n\nO cliente concordou com os termos e assinou o contrato via plataforma.\n\n📄 *Segue em anexo o PDF final gerado automaticamente pelo sistema.*`;
    
    if (adminAssinatura1) {
      await dispararEvolution(urlApi, apiKey, 'sendMedia', { number: adminAssinatura1, mediatype: 'document', fileName: `Contrato_Assinado_${after.codigoReserva || '001'}.pdf`, media: pdfAssinadoBase64 });
      await dispararEvolution(urlApi, apiKey, 'sendText', { number: adminAssinatura1, text: msgAdminAssinatura });
    }
    if (adminAssinatura2) {
      await dispararEvolution(urlApi, apiKey, 'sendMedia', { number: adminAssinatura2, mediatype: 'document', fileName: `Contrato_Assinado_${after.codigoReserva || '001'}.pdf`, media: pdfAssinadoBase64 });
      await dispararEvolution(urlApi, apiKey, 'sendText', { number: adminAssinatura2, text: msgAdminAssinatura });
    }

    // Disparo Exclusivo para o Entregador (Roteirização Automática)
    if (after.tipoLogistica === 'entrega' && motorista && after.enderecoEntrega) {
      const pendenteCobrar = (after.valorPendente || 0).toFixed(2);
      const dataEventoFormato = after.dataEvento ? after.dataEvento.split('-').reverse().join('/') : 'N/A';
      const horarioPrevisto = after.horarioRetirada || 'A combinar';
      
      // Gera Link de Rota do Google Maps com a API Universal oficial
      const linkMaps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(after.enderecoEntrega)}`;

      const msgMotorista = `🚚 *NOVA ROTA DE ENTREGA!*\n\n*Cliente:* ${after.cliente?.nome}\n*Telefone:* ${after.cliente?.whatsapp || 'N/A'}\n*Data do Evento:* ${dataEventoFormato}\n*Horário Previsto:* ${horarioPrevisto}\n*Peça(s):* ${nomesBolosStr}\n\n📍 *Endereço Completo:*\n${after.enderecoEntrega}\n\n🗺️ *Traçar Rota no GPS:*\n${linkMaps}\n\n💰 *Cobrança no Local:* ${after.valorPendente > 0 ? `R$ ${pendenteCobrar} (A cobrar)` : 'NADA A COBRAR (Totalmente Quitado)'}`;
      
      await dispararEvolution(urlApi, apiKey, 'sendText', { number: motorista, text: msgMotorista });
    }
  }
});

// ==========================================
// MOTOR GERADOR DE PDF (PDFKIT IN-MEMORY)
// ==========================================

async function gerarPdfOrcamentoBase64(dados: any, idPedido: string): Promise<string> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const buffers: any[] = [];

    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers).toString('base64')));

    // Paleta de Cores e Tipografia
    const corPrimaria = '#db2777'; // Rosa Ateliê (Tailwind Pink-600)
    const corSecundaria = '#475569'; // Slate-600
    const corAviso = '#ea580c'; // Orange-600

    // Cabeçalho (Identidade Visual)
    doc.fontSize(24).font('Helvetica-Bold').fillColor(corPrimaria).text('Arte Festiva Ateliê', { align: 'center' });
    doc.fontSize(10).font('Helvetica').fillColor(corSecundaria).text('PROPOSTA OFICIAL DE ORÇAMENTO', { align: 'center', characterSpacing: 2 });
    doc.moveDown(2);

    // Bloco 1: Informações do Cliente
    doc.rect(50, doc.y, 495, 1).fillColor(corPrimaria).fill();
    doc.moveDown(1);
    doc.fontSize(12).font('Helvetica-Bold').fillColor(corSecundaria).text('DADOS DO CONTRATANTE');
    doc.font('Helvetica').fontSize(10);
    doc.text(`Nome Completo: ${dados.cliente?.nome || 'N/A'}`);
    doc.text(`WhatsApp: ${dados.cliente?.whatsapp || 'N/A'}`);
    doc.text(`CPF: ${dados.cliente?.cpf || 'N/A'}`);
    doc.moveDown(1.5);

    // Bloco 2: Especificações Técnicas e Logística
    doc.rect(50, doc.y, 495, 1).fillColor(corPrimaria).fill();
    doc.moveDown(1);
    doc.fontSize(12).font('Helvetica-Bold').fillColor(corSecundaria).text('ESPECIFICAÇÕES DA LOCAÇÃO');
    doc.font('Helvetica').fontSize(10);
    
    if (dados.bolos && dados.bolos.length > 0) {
      doc.text('Peças Solicitadas:');
      dados.bolos.forEach((b: any) => doc.text(`- ${b.nomeBolo || b.nome} (Ref: ${b.codigo || 'N/A'})`));
    } else {
      doc.text(`Peça Solicitada: ${dados.nomeBolo}`);
    }

    doc.text(`Data do Evento: ${dados.dataEvento ? dados.dataEvento.split('-').reverse().join('/') : 'N/A'}`);
    
    const logisticaTexto = dados.tipoLogistica === 'entrega' ? 'Entrega no Local Acordado' : 'Retirada no Ateliê (Cliente)';
    doc.text(`Logística Definida: ${logisticaTexto}`);
    if (dados.tipoLogistica === 'entrega' && dados.enderecoEntrega) {
      doc.text(`Endereço de Entrega: ${dados.enderecoEntrega}`);
    }
    doc.moveDown(1.5);

    // Bloco 3: Balanço Financeiro
    doc.rect(50, doc.y, 495, 1).fillColor(corPrimaria).fill();
    doc.moveDown(1);
    doc.fontSize(12).font('Helvetica-Bold').fillColor(corSecundaria).text('BALANÇO FINANCEIRO');
    doc.font('Helvetica').fontSize(10);
    
    const valorPeca = (dados.valorTotalAcordado || 0) - (dados.valorEntrega || 0);
    doc.text(`Locação da Peça Cenográfica: R$ ${valorPeca.toFixed(2)}`);
    if (dados.tipoLogistica === 'entrega') {
      doc.text(`Taxa de Deslocamento (Frete): R$ ${(dados.valorEntrega || 0).toFixed(2)}`);
    }
    doc.moveDown(0.5);
    doc.fontSize(14).font('Helvetica-Bold').fillColor(corPrimaria).text(`CUSTO TOTAL: R$ ${(dados.valorTotalAcordado || 0).toFixed(2)}`);
    doc.moveDown(2);

    // Bloco 4: Termos e Avisos de Segurança
    doc.rect(50, doc.y, 495, 1).fillColor('#cbd5e1').fill(); // Linha cinza clara
    doc.moveDown(1);
    doc.fontSize(11).font('Helvetica-Bold').fillColor(corAviso).text('⚠️ REGRAS DE RESERVA E EXPIRAÇÃO');
    doc.font('Helvetica').fontSize(9).fillColor(corSecundaria);
    doc.text('1. Validade: Este documento garante o bloqueio da data solicitada por exatas 24 horas a partir da sua emissão no sistema.');
    doc.moveDown(0.3);
    doc.text('2. Quebra de Acordo: Caso o pagamento do Sinal de Reserva não seja processado dentro do período de tolerância, o sistema operacional do Ateliê liberará a peça para outros clientes de forma automática e irreversível.');
    doc.moveDown(0.3);
    doc.text('3. Segurança Jurídica: A reserva final só será chancelada após a identificação do pagamento na modalidade PIX e a assinatura digital do contrato de locação correspondente.');

    // Rodapé de Validação
    doc.moveDown(4);
    doc.fontSize(8).fillColor('#94a3b8').text(`Protocolo Sistêmico de Rastreio: ${dados.codigoReserva || idPedido}`, { align: 'center' });
    doc.text(`Documento emitido de forma automatizada em ${new Date().toLocaleDateString('pt-BR')} às ${new Date().toLocaleTimeString('pt-BR')}`, { align: 'center' });

    doc.end();
  });
}

async function gerarPdfContratoAssinadoBase64(dados: any, idPedido: string): Promise<string> {
  // 1. Busca a assinatura fixa da Gê no Storage da nuvem antes de montar o PDF
  let assinaturaGeBuffer: Buffer | null = null;
  try {
    const urlGe = 'https://firebasestorage.googleapis.com/v0/b/arte-festiva-atelie.firebasestorage.app/o/assinaturas_ge%2Fassinatura.png?alt=media&token=7f209bc5-f308-4f9f-8008-b35df7d15ccb';
    const res = await fetch(urlGe);
    if (res.ok) assinaturaGeBuffer = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.error("Aviso: Não foi possível carregar a assinatura da Gê para o PDF.", err);
  }

  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const buffers: any[] = [];

    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers).toString('base64')));

    // Formatadores Nativos
    const formatMoeda = (valor: number) => (valor || 0).toFixed(2);
    const formatData = (dataStr: string) => dataStr ? dataStr.split('-').reverse().join('/') : 'N/A';
    const hojeStr = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const horaStr = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    // Matematica Contábil do Banco
    const valorSinal = dados.valorSinalAcordado || dados.valorSinalPago || 0;
    const valorPendente = dados.valorPendente || 0;
    const valorEntrega = dados.valorEntrega || 0;
    const valorTotal = dados.valorTotalAcordado || 0;
    const valorReposicao = 450.00; // Padrão da regra de negócios

    // 1. Título e Identidade
    doc.fontSize(14).font('Helvetica-Bold').text('CONTRATO DE LOCAÇÃO DE BOLO CENOGRÁFICO', { align: 'center' });
    doc.moveDown(1.5);

    // 2. Preâmbulo
    doc.fontSize(10).font('Helvetica');
    doc.text('Pelo presente instrumento particular, de um lado: GERUZA PERUCHI DA ROSA, inscrita no CNPJ nº 45.439.303/0001-43, CPF nº 035.858.049-85, com nome fantasia ARTE FESTIVA ATELIÊ, estabelecida na Av. Luiz Lazzarin, Vila Floresta II, nº 730, sala 2, Criciúma/SC, doravante denominada CONTRATADA.', { align: 'justify' });
    doc.moveDown(0.5);
    doc.text(`E de outro lado: ${(dados.cliente?.nome || '').toUpperCase()}, CPF nº ${dados.cliente?.cpf || 'N/A'}, residente e domiciliado(a) em ${(dados.cliente?.endereco || '').toUpperCase()}, doravante denominado(a) CONTRATANTE.`, { align: 'justify' });
    doc.moveDown(1);
    doc.text('As partes firmam o presente contrato mediante as seguintes cláusulas:');
    doc.moveDown(1);

    // 3. Cláusula 1
    doc.font('Helvetica-Bold').text('CLÁUSULA 1 - DO OBJETO');
    
    let descPecas = '';
    let qtdPecas = 1;
    if (dados.bolos && dados.bolos.length > 0) {
       descPecas = dados.bolos.map((b: any) => `- ${b.nomeBolo || b.nome} (Cód: ${b.codigo || 'N/A'})`).join('\n');
       qtdPecas = dados.bolos.length;
    } else {
       descPecas = `- ${dados.nomeBolo}`;
    }

    doc.font('Helvetica').text(`1.1. O presente contrato tem por objeto a locação de itens decorativos de propriedade da LOCADORA, conforme especificação abaixo:\nItens Locados:\n${descPecas}\nDescrição: Peças decorativas em biscuit feitas manualmente.\nTema: ${dados.tema || 'Conforme Catálogo'}\nQuantidade de Peças: ${qtdPecas}\nData do Evento: ${formatData(dados.dataEvento)}`);
    doc.moveDown(0.5);
    doc.text('1.2. Os itens destinam-se exclusivamente à finalidade decorativa, sendo expressamente proibido uso diverso, consumo, modificação estrutural ou qualquer alteração sem autorização da CONTRATADA.');
    doc.moveDown(1);

    // 4. Cláusula 2
    doc.font('Helvetica-Bold').text('CLÁUSULA 2 - DO PRAZO E LOGÍSTICA');
    const modalidade = dados.tipoLogistica === 'entrega' ? 'ENTREGA NO LOCAL' : 'RETIRADA NO ATELIÊ';
    const enderecoOuRetirada = dados.tipoLogistica === 'entrega' ? `Endereço de Entrega: ${dados.enderecoEntrega || 'N/A'}` : `Data de retirada: ${formatData(dados.dataRetiradaAcordada)}`;
    doc.font('Helvetica').text(`Modalidade: ${modalidade}\n${enderecoOuRetirada}\nData de devolução: ${formatData(dados.dataDevolucaoAcordada)}\nHorário ajustado: ${dados.horarioRetirada || 'A combinar'}`);
    doc.moveDown(0.5);
    const logisticaTexto = dados.tipoLogistica === 'entrega' ? 'A entrega será realizada pela CONTRATADA no endereço especificado acima mediante taxa de deslocamento acordada.' : 'A retirada e devolução ocorrerão no endereço da CONTRATADA, sendo responsabilidade exclusiva do CONTRATANTE.';
    doc.text(`2.1. ${logisticaTexto}`);
    doc.text('2.2. A não devolução na data estipulada implicará multa de 10% sobre o valor total da locação, sem prejuízo de outras penalidades previstas neste contrato.');
    doc.moveDown(1);

    // 5. Cláusula 3
    doc.font('Helvetica-Bold').text('CLÁUSULA 3 - DO VALOR E DO PAGAMENTO');
    const txtSinal = dados.tipoLogistica === 'entrega' ? `(Incluso R$ ${formatMoeda(valorEntrega)} referentes à taxa de entrega)` : '';
    doc.font('Helvetica').text(`3.1. O valor total do serviço é de R$ ${formatMoeda(valorTotal)} ${txtSinal}`);
    doc.text(`3.2. O pagamento será realizado da seguinte forma:\nR$ ${formatMoeda(valorSinal)} a título de sinal/reserva, no ato do agendamento;\nR$ ${formatMoeda(valorPendente)} na data da retirada/entrega do item locado.\nForma de pagamento: Pix (Plataforma Digital)`);
    doc.text('3.3. A reserva somente será confirmada mediante o pagamento do sinal.');
    doc.text('3.4. O não pagamento da parcela final na data da retirada implicará rescisão automática do contrato, com retenção do sinal pago.');
    doc.moveDown(1);

    // 6. Cláusulas 4 e 5
    doc.font('Helvetica-Bold').text('CLÁUSULA 4 - DAS OBRIGAÇÕES DA CONTRATADA');
    doc.font('Helvetica').text('4.1. Entregar o(s) item(ns) locado(s) na data ajustada, em perfeito estado de conservação e limpeza.\n4.2. Prestar informações necessárias quanto ao correto manuseio e conservação do material.\n4.3. Disponibilizar item compatível com o contratado, conforme especificação constante neste instrumento.');
    doc.moveDown(1);
    
    doc.font('Helvetica-Bold').text('CLÁUSULA 5 - DAS OBRIGAÇÕES DO CONTRATANTE');
    doc.font('Helvetica').text('5.1. Retirar e devolver os itens nas datas ajustadas.\n5.2. Efetuar o pagamento integral conforme cláusula 3.\n5.3. Utilizar o material exclusivamente para fins decorativos, comprometendo-se a não aplicar cola, fita permanente, tinta, água ou qualquer substância que possa danificar a peça, bem como a não realizar alterações estruturais ou adaptações sem autorização.\n5.4. Manter o item em perfeito estado durante o período de locação.\n5.5. Devolver o material nas mesmas condições em que foi recebido.\n5.6. Responsabilizar-se por qualquer dano, perda, extravio ou avaria, comprometendo-se a ressarcir integralmente o valor correspondente.');
    doc.moveDown(1);

    // 7. Cláusula 6
    doc.font('Helvetica-Bold').text('CLÁUSULA 6 - DO USO, CONSERVAÇÃO E DEVOLUÇÃO DO MATERIAL LOCADO');
    doc.font('Helvetica').text(`6.1. O CONTRATANTE declara receber o material em perfeito estado.\n6.2. Eventuais avarias serão avaliadas pela CONTRATADA, que apresentará orçamento para reparo ou substituição.\n6.3. Em caso de perda total ou não devolução, o LOCATÁRIO deverá ressarcir o valor integral das peças abaixo descritas:\nValor de reposição: R$ ${formatMoeda(valorReposicao)} (Por peça locada)`);
    doc.moveDown(1);

    // 8. Cláusulas 7 a 10
    doc.font('Helvetica-Bold').text('CLÁUSULA 7 - DA DESISTÊNCIA');
    doc.font('Helvetica').text('7.1. Em caso de desistência após a confirmação da reserva, o CONTRATANTE deverá pagar 50% do valor total da locação, correspondente aos custos operacionais de higienização, adaptação, bloqueio de agenda e montagem.\n7.2. Caso o valor pago seja inferior a 50%, deverá complementar até atingir esse percentual.');
    doc.moveDown(1);

    doc.font('Helvetica-Bold').text('CLÁUSULA 8 - DA RESCISÃO');
    doc.font('Helvetica').text('8.1. O descumprimento contratual por qualquer das partes poderá ensejar rescisão imediata, respondendo a parte inadimplente por eventuais perdas e danos.');
    doc.moveDown(1);

    doc.font('Helvetica-Bold').text('CLÁUSULA 9 - DA BOA-FÉ E CONDUTA');
    doc.font('Helvetica').text('9.1. As partes comprometem-se a agir com boa-fé, lealdade e cooperação, observando os princípios contratuais previstos na legislação civil.\n9.2. Eventuais situações não previstas serão resolvidas de comum acordo, sempre buscando equilíbrio e razoabilidade.');
    doc.moveDown(1);

    doc.font('Helvetica-Bold').text('CLÁUSULA 10 - DISPOSIÇÕES GERAIS');
    doc.font('Helvetica').text('10.1. Este contrato possui força executiva entre as partes.\n10.2. Fica eleito o foro da Comarca de Criciúma/SC para dirimir quaisquer controvérsias oriundas deste contrato.');
    doc.moveDown(1.5);

    // 9. Encerramento
    doc.text('E, por estarem justos e contratados, firmam o presente instrumento digitalmente via plataforma web.');
    doc.moveDown(1);
    doc.text(`Criciúma/SC, ${hojeStr}.`);
    doc.moveDown(2);

    // 10. Chancelamento Digital
    doc.rect(50, doc.y, 495, 1).fillColor('#16a34a').fill();
    doc.moveDown(1);
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#16a34a').text('✓ CHANCELA DE ASSINATURA DIGITAL VÁLIDA', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(9).font('Helvetica').fillColor('#475569');
    doc.text('Este documento atesta que o contratante leu, conferiu os dados e concordou plenamente com os Termos e Condições do Ateliê mediante assinatura digital registrada na plataforma web e pagamento da reserva sistêmica.', { align: 'center' });
    doc.moveDown(0.5);
    doc.text(`Data e Hora da Validação: ${hojeStr} às ${horaStr}`, { align: 'center' });
    doc.text(`Protocolo Sistêmico de Rastreio: ${dados.codigoReserva || idPedido}`, { align: 'center' });

    // 11. Imagens das Assinaturas e Linhas Físicas
    doc.moveDown(5); // Força um belo espaço vertical para as imagens caberem sem encavalar no texto
    const ySign = doc.y;
    doc.fillColor('#000000'); // Reseta a cor para preto

    // Injeta a Assinatura da Gê (lado esquerdo)
    if (assinaturaGeBuffer) {
      try {
        // x: 80 centraliza a imagem acima da linha da esquerda
        // y: ySign - 45 coloca a imagem "pisando" na linha
        doc.image(assinaturaGeBuffer, 80, ySign - 45, { width: 120, height: 40 });
      } catch (e) { console.error("Falha ao desenhar assinatura da Gê", e); }
    }

    // Injeta a Assinatura do Cliente (lado direito)
    if (dados.assinaturaCliente) {
      try {
        // x: 350 centraliza a imagem acima da linha da direita
        doc.image(dados.assinaturaCliente, 350, ySign - 45, { width: 120, height: 40 });
      } catch (e) { console.error("Falha ao desenhar assinatura do Cliente", e); }
    }

    // Desenha as Linhas Base
    doc.moveTo(60, ySign).lineTo(240, ySign).stroke();
    doc.moveTo(310, ySign).lineTo(530, ySign).stroke();

    // Textos abaixo da linha
    doc.fontSize(9).font('Helvetica-Bold');
    doc.text('GERUZA PERUCHI DA ROSA', 60, ySign + 5);
    doc.text((dados.cliente?.nome || 'CONTRATANTE').toUpperCase(), 310, ySign + 5);

    doc.font('Helvetica');
    doc.text('ARTE FESTIVA ATELIÊ', 60, ySign + 17);
    doc.text('CONTRATANTE', 310, ySign + 17);

    doc.end();
  });
}

// ==========================================
// SESSÃO: INTEGRAÇÃO GOOGLE CALENDAR (DESPERTADOR)
// ==========================================

// Inicializa a autenticação com o Robô (Service Account)
const keyPath = path.join(__dirname, "../credentials.json");
const auth = new google.auth.GoogleAuth({
  keyFile: keyPath,
  scopes: ["https://www.googleapis.com/auth/calendar.events"],
});

const calendar = google.calendar({ version: "v3", auth });

// O email exato da conta Gmail que está logada no celular da Gê
const CALENDAR_ID = "maiconph@gmail.com"; 

export const agendarAlarmeLogistica = onDocumentUpdated("locacoes/{locacaoId}", async (event) => {
  const dataAntes = event.data?.before.data();
  const dataDepois = event.data?.after.data();

  if (!dataAntes || !dataDepois) return;

  const statusVelho = dataAntes.status;
  const statusNovo = dataDepois.status;

  // ---- SONDA DE DIAGNÓSTICO TÁTICO ----
  console.log(`[SONDA] Locação ${event.params.locacaoId} disparou a função!`);
  console.log(`[SONDA] Status Velho: [${statusVelho}] | Status Novo: [${statusNovo}]`);
  
  // Trava de Execução: Só dispara se o status MUDAR para um cenário de contrato fechado
  const fechouContrato = statusNovo === "pago" || statusNovo === "pago_parcialmente";
  const eraDiferente = statusVelho !== statusNovo;

  if (!fechouContrato || !eraDiferente) {
     console.log(`[SONDA] Abortado na trava de segurança! Motivos -> fechouContrato: ${fechouContrato} | eraDiferente: ${eraDiferente}`);
     return; 
  }
  
  console.log(`[SONDA] Trava liberada! Roteando para o Google Calendar: Dia ${dataDepois.dataRetiradaAcordada} às ${dataDepois.horarioRetirada}`);
  // -------------------------------------

  // Extrai dados logísticos
  const dataAcordada = dataDepois.dataRetiradaAcordada; 
  const horarioAcordado = dataDepois.horarioRetirada; 
  const clienteNome = dataDepois.cliente?.nome || "Cliente";
  const nomeBolo = dataDepois.nomeBolo || "Múltiplos Itens";
  const tipoLogistica = dataDepois.tipoLogistica === "entrega" ? "ENTREGA" : "RETIRADA";

  // Aborta se o contrato foi fechado sem especificar dia/hora
  if (!dataAcordada || !horarioAcordado) {
    console.warn(`Locação ${event.params.locacaoId} sem data/hora. Alarme abortado.`);
    return;
  }

  try {
    // Monta a data e hora do evento blindada no fuso horário de Brasília
    const dataHoraIso = `${dataAcordada}T${horarioAcordado}:00-03:00`;
    
    // Calcula o fim do evento somando 30 minutos na string para o bloco visual do calendário
    const partesTempo = horarioAcordado.split(':');
    const dataObjFim = new Date();
    dataObjFim.setHours(parseInt(partesTempo[0], 10), parseInt(partesTempo[1], 10) + 30, 0);
    const horaFim = dataObjFim.getHours().toString().padStart(2, '0');
    const minFim = dataObjFim.getMinutes().toString().padStart(2, '0');
    const dataHoraFimIso = `${dataAcordada}T${horaFim}:${minFim}:00-03:00`;

    // Payload da API com a injeção da metralhadora de lembretes forçados
    const evento = {
      summary: `🚨 ${tipoLogistica}: ${nomeBolo} (${clienteNome})`,
      description: `Atenção! O cliente ${clienteNome} agendou a ${tipoLogistica.toLowerCase()} para as ${horarioAcordado}.\n\nWhatsApp: ${dataDepois.cliente?.whatsapp || 'N/A'}\nProtocolo: ${dataDepois.codigoReserva || 'N/A'}`,
      start: {
        dateTime: dataHoraIso,
        timeZone: "America/Sao_Paulo",
      },
      end: {
        dateTime: dataHoraFimIso,
        timeZone: "America/Sao_Paulo",
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: "popup", minutes: 180 }, // Apita 3h antes
          { method: "popup", minutes: 170 }, // Apita 2h50m antes
          { method: "popup", minutes: 160 }, // Apita 2h40m antes
        ],
      },
    };

    // Dispara a requisição com atualização forçada para aplicar os lembretes
    await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: evento,
      sendUpdates: 'all'
    });

    console.log(`Despertador logístico ativado com sucesso para o cliente ${clienteNome}.`);
  } catch (error) {
    console.error("Falha técnica ao tentar injetar evento no Google Calendar:", error);
  }
});

// ==========================================
// SESSÃO: AUTOMAÇÃO DE COBRANÇA MENSALISTAS (ROBÔ DIÁRIO)
// ==========================================
export const cobrarMensalistasCron = onSchedule({
  schedule: "0 8 * * *", // Roda todos os dias às 08h00 da manhã
  timeZone: "America/Sao_Paulo",
  retryCount: 3
}, async (event) => {
  console.log("Iniciando varredura diária de cobrança de mensalistas...");

  // 1. Determina o dia atual travado no fuso correto do Brasil
  const hojeStr = new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" });
  const hojeObj = new Date(hojeStr);
  const diaHoje = hojeObj.getDate();
  const dataIso = hojeObj.toISOString().split('T')[0]; // YYYY-MM-DD

  try {
    // 2. Resgata todos os inadimplentes (A técnica de filtrar o dia em memória evita criar índices caros no Firestore)
    const mensalistasSnap = await db.collection('mensalistas').where('saldoDevedor', '>', 0).get();

    if (mensalistasSnap.empty) {
      console.log("Nenhum parceiro com saldo devedor encontrado no banco.");
      return;
    }

    const alvosCobranca = mensalistasSnap.docs.filter(doc => {
      const dados = doc.data();
      return Number(dados.diaVencimento) === diaHoje;
    });

    if (alvosCobranca.length === 0) {
      console.log(`Nenhum vencimento programado para o dia ${diaHoje}. Máquina em repouso.`);
      return;
    }

    // 3. Coleta de Credenciais Dinâmicas
    const [asaasSnap, whatsSnap] = await Promise.all([
      db.doc('configuracoes/asaas').get(),
      db.doc('configuracoes/whatsapp').get()
    ]);

    const asaasKey = asaasSnap.data()?.apiKey;
    const whatsUrl = whatsSnap.data()?.urlApi;
    const whatsKey = whatsSnap.data()?.apiKey;

    if (!asaasKey || !whatsUrl || !whatsKey) {
      throw new Error("Credenciais do Gateway Asaas ou Evolution API não configuradas no painel.");
    }

    // Helper interno blindado para a API do Asaas
    const fetchAsaas = async (endpoint: string, method: string, body?: any) => {
      const res = await fetch(`https://api.asaas.com/v3${endpoint}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'access_token': asaasKey,
          'User-Agent': 'ArteFestivaApp-Cron/1.0'
        },
        body: body ? JSON.stringify(body) : undefined
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Erro Asaas ${res.status}: ${text}`);
      return text ? JSON.parse(text) : {};
    };

    // 4. Orquestração e Disparos
    let cobrancasEnviadas = 0;

    for (const docSnapshot of alvosCobranca) {
      const m = docSnapshot.data();
      const numFormatado = higienizarNumero(m.whatsapp);

      // Trava de segurança: Se o parceiro não tiver CPF/CNPJ, o Asaas rejeita
      if (!m.documento || !numFormatado) {
         console.error(`Mensalista ${m.nome} ignorado: CPF/CNPJ ou WhatsApp não cadastrado.`);
         continue;
      }

      try {
        // A. Cria ou Resgata o Cliente Oculto no Asaas pelo CPF/CNPJ
        const cliente = await fetchAsaas('/customers', 'POST', { name: m.nome, cpfCnpj: m.documento });

        // B. Gera a Fatura Pix Dinâmica
        const cobranca = await fetchAsaas('/payments', 'POST', {
          customer: cliente.id,
          billingType: "PIX",
          value: m.saldoDevedor,
          dueDate: dataIso,
          description: `Fatura Mensal Arte Festiva - Vencimento Dia ${diaHoje}`,
          externalReference: `MENSALISTA_${docSnapshot.id}` // Salva a referência para possível webhook futuro
        });

        // C. Resgata o Payload Copia e Cola gerado
        const qrCodeData = await fetchAsaas(`/payments/${cobranca.id}/pixQrCode`, 'GET');

        // D. Disparo 1: Mensagem Formal
        const saudacao = `Olá *${m.nome.split(' ')[0]}*, tudo bem?\nAqui é a Gerusa da *Arte Festiva Ateliê*.\n\nPassando para informar que a sua fatura mensal referente aos nossos bolos fechou em *R$ ${m.saldoDevedor.toFixed(2)}* com vencimento para hoje (Dia ${diaHoje}).\n\nPara facilitar, geramos a sua cobrança via Pix. O código "Copia e Cola" está logo abaixo para você realizar o pagamento direto no aplicativo do seu banco.\n\nQualquer dúvida sobre o extrato das locações, estou totalmente à disposição!`;

        await dispararEvolution(whatsUrl, whatsKey, 'sendText', {
          number: numFormatado,
          text: saudacao
        });

        // D. Disparo 2: Apenas a chave isolada
        await dispararEvolution(whatsUrl, whatsKey, 'sendText', {
          number: numFormatado,
          text: qrCodeData.payloadA
        });

        cobrancasEnviadas++;
        console.log(`Fatura automatizada enviada para ${m.nome} com sucesso.`);

      } catch (err: any) {
        console.error(`Falha no pipeline de cobrança do mensalista ${m.nome}:`, err.message);
      }
    }

    console.log(`🚀 Máquina de cobrança finalizada. ${cobrancasEnviadas} boletos Pix gerados e disparados.`);

  } catch (error) {
    console.error("Erro crítico no CRON Job de Mensalistas:", error);
  }
});

// ==========================================
// SESSÃO: ROTINA MATINAL DE LOGÍSTICA E PIX
// ==========================================
export const rotinaMatinalLogistica = onSchedule({
  schedule: "0 8 * * *", // Executa impreterivelmente às 08h00 da manhã
  timeZone: "America/Sao_Paulo",
  retryCount: 3
}, async (event) => {
  console.log("Iniciando varredura diária de logística e cobrança matinal...");

  const hojeStr = new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" });
  const hojeObj = new Date(hojeStr);
  const dataHojeIso = hojeObj.toISOString().split('T')[0]; // YYYY-MM-DD

  try {
    // 1. Coleta Credenciais Dinâmicas usando a sintaxe nativa do Admin SDK (db.doc().get())
    const asaasConfigSnap = await db.doc('configuracoes/asaas').get();
    const whatsConfigSnap = await db.doc('configuracoes/whatsapp').get();

    const asaasKey = asaasConfigSnap.data()?.apiKey;
    const whatsUrl = whatsConfigSnap.data()?.urlApi;
    const whatsKey = whatsConfigSnap.data()?.apiKey;
    const configWhats = whatsConfigSnap.data();

    if (!asaasKey || !whatsUrl || !whatsKey || !configWhats) {
      throw new Error("Configurações de infraestrutura ausentes no Firestore.");
    }

    const motorista = higienizarNumero(configWhats.numeroEntregador);

    // Helper interno para conversar com o Asaas
    const fetchAsaas = async (endpoint: string, method: string, body?: any) => {
      const res = await fetch(`https://api.asaas.com/v3${endpoint}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'access_token': asaasKey,
          'User-Agent': 'ArteFestivaApp-Cron/1.0'
        },
        body: body ? JSON.stringify(body) : undefined
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Erro Asaas: ${text}`);
      return text ? JSON.parse(text) : {};
    };

    // ==========================================
    // SUB-ROTINE A: PROCESSAMENTO DE ENTREGAS (HOJE)
    // ==========================================
    const snapshotEntregas = await db.collection('locacoes')
      .where('dataEvento', '==', dataHojeIso)
      .where('tipoLogistica', '==', 'entrega')
      .where('status', '==', 'contrato_assinado')
      .get();

    if (!snapshotEntregas.empty) {
      for (const docSnapshot of snapshotEntregas.docs) {
        const loc = docSnapshot.data();
        const numCliente = higienizarNumero(loc.cliente?.whatsapp);
        const valorPendente = Number(loc.valorPendente || 0);
        
        const nomesBolosStr = loc.bolos && loc.bolos.length > 0 
          ? loc.bolos.map((b: any) => b.nomeBolo || b.nome).join(', ') 
          : loc.nomeBolo || "Múltiplos Itens";

        // Se houver pendência financeira, gera cobrança de acerto e manda pro cliente
        if (valorPendente > 0 && numCliente) {
          try {
            const clienteAsaas = await fetchAsaas('/customers', 'POST', { name: loc.cliente.nome, cpfCnpj: loc.cliente.cpf || '' });
            const cobranca = await fetchAsaas('/payments', 'POST', {
              customer: clienteAsaas.id,
              billingType: "PIX",
              value: valorPendente,
              dueDate: dataHojeIso,
              description: `Acerto Final de Locação - Ref: ${loc.codigoReserva || docSnapshot.id}`,
              externalReference: docSnapshot.id
            });

            const qrCodeData = await fetchAsaas(`/payments/${cobranca.id}/pixQrCode`, 'GET');

            const textCliente = `Olá *${loc.cliente?.nome?.split(' ')[0] || 'Cliente'}*!\n\nSeu bolo já está sendo preparado para entrega hoje! 🎂\n\nIdentificamos um saldo pendente de *R$ ${valorPendente.toFixed(2)}*. Para sua comodidade, geramos o código PIX para o acerto final. Você pode pagar apontando para o QR Code abaixo ou copiando a chave de pagamento:`;
            
            await dispararEvolution(whatsUrl, whatsKey, 'sendText', { number: numCliente, text: textCliente });
            await dispararEvolution(whatsUrl, whatsKey, 'sendMedia', { number: numCliente, mediatype: 'image', fileName: 'qrcode.png', media: qrCodeData.encodedImage });
            await dispararEvolution(whatsUrl, whatsKey, 'sendText', { number: numCliente, text: qrCodeData.payload });
          } catch (err) {
            console.error(`Falha ao faturar acerto matinal para doc ${docSnapshot.id}:`, err);
          }
        }

        // Envia lembrete limpo para o entregador (Oculta valor se for fluxo PIX)
        if (motorista) {
          const txtCobranca = valorPendente === 0 
            ? "Valor a cobrar: R$ 0,00 (Já Pago) ✅" 
            : "Forma de acerto: Link PIX enviado ao cliente (Aguardando sistema) 📲";

          const msgMotoboy = `🚚 *LEMBRETE DE ENTREGA HOJE*\n\n• *Bolo:* ${nomesBolosStr}\n• *Cliente:* ${loc.cliente?.nome || 'N/A'}\n• *Horário Previsto:* ${loc.horarioRetirada || 'A combinar'}\n\n📍 *Endereço Completo:*\n${loc.enderecoEntrega || 'N/A'}\n\n🗺️ *Traçar Rota no GPS:*\nhttps://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc.enderecoEntrega || '')}\n\n💰 *Status:* ${txtCobranca}`;
          
          await dispararEvolution(whatsUrl, whatsKey, 'sendText', { number: motorista, text: msgMotoboy });
        }
      }
    }

    // ==========================================
    // SUB-ROUTINE B: PROCESSAMENTO DE DEVOLUÇÕES (HOJE)
    // ==========================================
    const snapshotDevolucoes = await db.collection('locacoes')
      .where('dataDevolucaoAcordada', '==', dataHojeIso)
      .where('status', '==', 'entregue')
      .get();

    if (!snapshotDevolucoes.empty) {
      for (const docSnapshot of snapshotDevolucoes.docs) {
        const loc = docSnapshot.data();
        const numCliente = higienizarNumero(loc.cliente?.whatsapp);
        const valorPendente = Number(loc.valorPendente || 0);

        const nomesBolosStr = loc.bolos && loc.bolos.length > 0 
          ? loc.bolos.map((b: any) => b.nomeBolo || b.nome).join(', ') 
          : loc.nomeBolo || "Múltiplos Itens";

        // Se houver resíduo de valor na devolução, cobra o cliente
        if (valorPendente > 0 && numCliente) {
          try {
            const clienteAsaas = await fetchAsaas('/customers', 'POST', { name: loc.cliente.nome, cpfCnpj: loc.cliente.cpf || '' });
            const cobranca = await fetchAsaas('/payments', 'POST', {
              customer: clienteAsaas.id,
              billingType: "PIX",
              value: valorPendente,
              dueDate: dataHojeIso,
              description: `Saldo Residual Devolução - Ref: ${loc.codigoReserva || docSnapshot.id}`,
              externalReference: docSnapshot.id
            });

            const qrCodeData = await fetchAsaas(`/payments/${cobranca.id}/pixQrCode`, 'GET');

            const textClienteRetorno = `Olá *${loc.cliente?.nome?.split(' ')[0] || 'Cliente'}*!\n\nHoje é o dia de devolução do bolo decorativo alugado. 😊\n\nIdentificamos que restou um saldo devedor de *R$ ${valorPendente.toFixed(2)}*. Segue abaixo o código PIX para a quitação do contrato:`;
            
            await dispararEvolution(whatsUrl, whatsKey, 'sendText', { number: numCliente, text: textClienteRetorno });
            await dispararEvolution(whatsUrl, whatsKey, 'sendMedia', { number: numCliente, mediatype: 'image', fileName: 'qrcode.png', media: qrCodeData.encodedImage });
            await dispararEvolution(whatsUrl, whatsKey, 'sendText', { number: numCliente, text: qrCodeData.payload });
          } catch (err) {
            console.error(`Falha ao faturar resíduo de devolução para doc ${docSnapshot.id}:`, err);
          }
        } else if (numCliente) {
          // Se não há pendência, envia apenas o lembrete cordial padrão de agendamento
          const msgGeralRetorno = `Olá *${loc.cliente?.nome?.split(' ')[0] || 'Cliente'}*! Hoje é o dia da devolução do bolo decorativo alugado. 😊\n\nNosso entregador entrará em contato diretamente com você pelo WhatsApp para alinhar o melhor horário para passar e retirar a peça. Agradecemos desde já!`;
          await dispararEvolution(whatsUrl, whatsKey, 'sendText', { number: numCliente, text: msgGeralRetorno });
        }

        // Envia a ordem de recolha descentralizada para o motorista
        if (motorista && numCliente) {
          const msgMotoristaRetorno = `📦 *RECOLHA DE BOLO HOJE*\n\n• *Bolo:* ${nomesBolosStr}\n• *Cliente:* ${loc.cliente?.nome || 'N/A'}\n• *WhatsApp Cliente:* wa.me/${numCliente}\n\n👉 *Instrução:* Envie um ZAP para a cliente acima para combinar o melhor horário para você buscar o bolo hoje.`;
          await dispararEvolution(whatsUrl, whatsKey, 'sendText', { number: motorista, text: msgMotoristaRetorno });
        }
      }
    }

    console.log("Sucesso Operacional: Varredura logística matinal concluída.");
  } catch (error) {
    console.error("Erro crítico na execução do CRON Job logístico matinal:", error);
  }
});