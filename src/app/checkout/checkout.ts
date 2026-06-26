import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { Firestore, doc, onSnapshot, updateDoc, Unsubscribe } from '@angular/fire/firestore';

@Component({
  selector: 'app-checkout',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './checkout.html'
})
export class CheckoutView implements OnInit, OnDestroy {
  private firestore = inject(Firestore);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  locacaoId: string | null = null;
  locacao: any = null;
  carregando = true;

  // Controle de UI do Modal Interceptador
  mostrarModalCancelamento = true; 
  cancelando = false;

  // Controle do Gateway (Gateway Híbrido)
  metodoPagamento: 'pix_manual' | 'asaas' = 'asaas';

  // Controle de Estado da Malha Asaas
  gerandoPix = false;
  qrCodeBase64 = '';
  pixCopiaECola = '';
  copiouPix = false;

  // Variável para armazenar o listener e poder matá-lo depois
  private locacaoSub: Unsubscribe | null = null;

  ngOnInit() {
    this.locacaoId = this.route.snapshot.paramMap.get('id');
    if (this.locacaoId) {
      this.carregarDadosLocacao(this.locacaoId);
    } else {
      this.carregando = false;
    }
  }

  ngOnDestroy() {
    // Profiling: Mata o ouvinte do Firebase quando o cliente sai da rota
    if (this.locacaoSub) {
      this.locacaoSub();
    }
  }

  carregarDadosLocacao(id: string) {
    try {
      const docRef = doc(this.firestore, `locacoes/${id}`);
      
      // onSnapshot cria um túnel aberto com o Firebase. Qualquer alteração dispara esse bloco novamente.
      this.locacaoSub = onSnapshot(docRef, (docSnap) => {
        if (docSnap.exists()) {
          this.locacao = { id: docSnap.id, ...docSnap.data() };
          this.carregando = false;

          // BLINDAGEM CONTRA RETORNO: Se já passou da fase de pagamento, expulsa o usuário imediatamente
          const statusPosPagamento = ['contrato_assinado', 'entregue', 'finalizado'];
          if (statusPosPagamento.includes(this.locacao.status)) {
             this.avancarParaAssinatura();
             return;
          }

          // GATILHO AUTOMÁTICO: Avança apenas se o status estiver pago E não estivermos no modal de intenção
          if ((this.locacao.status === 'pago' || this.locacao.status === 'pago_parcialmente') && !this.mostrarModalCancelamento) {
             this.avancarParaAssinatura();
             return;
          }

          // Trava de Negócio Refinada: Só esconde o modal se estivermos em um status de fluxo avançado
          const statusAtivos = ['pago', 'pago_parcialmente', 'contrato_assinado', 'entregue', 'finalizado'];
          if (statusAtivos.includes(this.locacao.status)) {
             this.mostrarModalCancelamento = false;
          }
        } else {
          this.locacao = null;
          this.carregando = false;
        }
      }, (error) => {
        console.error('Erro no Listener do Checkout:', error);
        this.carregando = false;
      });

    } catch (error) {
      console.error('Falha ao iniciar Listener no checkout:', error);
      this.carregando = false;
    }
  }

  async aceitarContrato() {
    this.mostrarModalCancelamento = false;
    
    // Disparo imediato da requisição em background
    if (this.metodoPagamento === 'asaas') {
       await this.solicitarPixAsaas();
    }
  }

  async solicitarPixAsaas() {
    this.gerandoPix = true;
    try {
      // ATENÇÃO: Após o deploy, cole aqui a URL pública gerada no console (terminada em /gerarPagamentoPix)
      const FUNCTION_URL = "https://gerarpagamentopix-qsk6sxgllq-uc.a.run.app"; 
      
      const payload = {
        nome: this.locacao?.cliente?.nome || 'Cliente Ateliê',
        cpf: this.locacao?.cliente?.cpf || '',
        valor: this.locacao?.valorSinalAcordado || 0,
        idLocacao: this.locacaoId
      };

      const res = await fetch(FUNCTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      // Validação blindada: Verifica se a resposta do servidor é realmente um JSON válido antes de fazer o parse
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        const erroBruto = await res.text();
        throw new Error(`Falha de Infraestrutura: O servidor retornou Status ${res.status}. Payload devolvido: ${erroBruto.substring(0, 150)}`);
      }

      const data = await res.json();
      
      if (data.sucesso) {
         this.qrCodeBase64 = `data:image/png;base64,${data.qrCodeBase64}`;
         this.pixCopiaECola = data.copiaECola;
      } else {
         alert("Não foi possível gerar o código Pix dinâmico.");
      }
    } catch (error) {
       console.error("Erro ao solicitar PIX ao backend:", error);
       alert("Falha técnica de comunicação.");
    } finally {
       this.gerandoPix = false;
    }
  }

  async recusarECancelar() {
    if (!this.locacaoId) return;
    this.cancelando = true;
    try {
      // Sintaxe Modular V9
      const docRef = doc(this.firestore, `locacoes/${this.locacaoId}`);
      await updateDoc(docRef, { status: 'cancelado' });
      this.locacao.status = 'cancelado';
      this.mostrarModalCancelamento = false;
    } catch (error) {
      console.error('Erro ao cancelar reserva:', error);
      alert('Falha técnica ao cancelar a operação. Tente novamente.');
    } finally {
      this.cancelando = false;
    }
  }

  avancarParaAssinatura() {
    // Redireciona para o fluxo da fase 3 APAGANDO o checkout do histórico de navegação
    // Se o cliente apertar 'Voltar' no celular, ele não consegue voltar para a tela de pagamento.
    this.router.navigate(['/assinatura', this.locacaoId], { replaceUrl: true });
  }

  copiarPix() {
    if (this.pixCopiaECola) {
      navigator.clipboard.writeText(this.pixCopiaECola);
      this.copiouPix = true;
      setTimeout(() => this.copiouPix = false, 2000);
    }
  }
}