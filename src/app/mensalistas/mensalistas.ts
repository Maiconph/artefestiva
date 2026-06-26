import { Component, OnInit, HostListener, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { BoloService } from '../services/bolo';
import { Observable, BehaviorSubject, combineLatest } from 'rxjs';
import { map } from 'rxjs/operators';

@Component({
  selector: 'app-mensalistas',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './mensalistas.html'
})
export class MensalistasComponent implements OnInit {
  private boloService = inject(BoloService);

  // Estado do Cadastro
  novoMensalista: any = { nome: '', documento: '', whatsapp: '', tipo: 'Casa de Festas', diaVencimento: '' };
  editandoId: string | null = null;
  loading = false;

  // Stream Reativo do Banco de Dados
  mensalistasCadastrados$: Observable<any[]> | null = null;

  // Estado do Modal de Detalhes
  showModalDetalhes = false;
  mensalistaSelecionado: any = null;
  
  // Fatura Aberta do Mensalista Selecionado (Mock)
  itensFaturaAberta: any[] = [];
  
  // Controle de Navegação Interna do Modal
  abaModal: 'financeiro' | 'lista' | 'nova_reserva' = 'financeiro';

  // Motor de Carrinho e Reservas
  bolosDisponiveis$: Observable<any[]> | null = null;
  bolosFiltrados$: Observable<any[]> | null = null;
  termoBuscaCatalogo$ = new BehaviorSubject<string>('');
  textoBuscaCatalogo = '';
  carrinho: any[] = [];
  dadosReserva = {
    dataEvento: '',
    dataDevolucao: '',
    horarioRetirada: '',
    tipoLogistica: 'retirada',
    enderecoEntrega: ''
  };

  // Controle de Acerto Financeiro
  valorPagoAgora: number = 0;
  valorPermuta: number = 0;

  // Controle de Histórico para Botão Voltar (Mobile/Android)
  modalAbertoViaHistory = false;

  ngOnInit() {
    // Engatilha a escuta em tempo real do banco ao abrir a aba
    this.mensalistasCadastrados$ = this.boloService.getMensalistas();
  }

  @HostListener('window:popstate', ['$event'])
  onPopState(event: any) {
    if (this.showModalDetalhes) {
      // Se o modal estiver aberto e o usuário usar o botão voltar do celular, fechamos o modal
      this.showModalDetalhes = false;
      this.modalAbertoViaHistory = false; // Reseta a flag para evitar rollback duplo
      document.body.style.overflow = '';
    }
  }

  async salvarMensalista() {
    if (!this.novoMensalista.nome || !this.novoMensalista.whatsapp) {
      alert("Operação Abortada: Preencha o nome e o WhatsApp do parceiro.");
      return;
    }

    this.loading = true;
    try {
      if (this.editandoId) {
        // Fluxo de Edição
        await this.boloService.atualizarMensalista(this.editandoId, {
          nome: this.novoMensalista.nome,
          documento: this.novoMensalista.documento,
          whatsapp: this.novoMensalista.whatsapp,
          tipo: this.novoMensalista.tipo,
          diaVencimento: this.novoMensalista.diaVencimento
        });
        alert('Parceiro atualizado com sucesso!');
      } else {
        // Fluxo de Criação
        await this.boloService.salvarMensalista(this.novoMensalista);
        alert('Sucesso: Parceiro cadastrado no sistema!');
      }
      
      this.cancelarEdicao(); // Limpa a UI em ambos os fluxos
    } catch (error) {
      console.error("Erro técnico ao salvar parceiro:", error);
      alert("Falha ao processar. Verifique sua conexão e tente novamente.");
    } finally {
      this.loading = false;
    }
  }

  editarMensalista(m: any) {
    this.editandoId = m.id;
    this.novoMensalista = { nome: m.nome, documento: m.documento || '', whatsapp: m.whatsapp, tipo: m.tipo, diaVencimento: m.diaVencimento || '' };
    window.scrollTo({ top: 0, behavior: 'smooth' }); // Rola suavemente até o formulário no topo
  }

  cancelarEdicao() {
    this.editandoId = null;
    this.novoMensalista = { nome: '', documento: '', whatsapp: '', tipo: 'Casa de Festas', diaVencimento: '' };
  }

  async excluirMensalista(m: any) {
    // Trava de Segurança Contábil
    if (m.saldoDevedor > 0) {
       alert(`❌ OPERAÇÃO NEGADA: O parceiro "${m.nome}" possui uma fatura pendente de R$ ${m.saldoDevedor.toFixed(2)}.\n\nEfetue o acerto financeiro antes de excluí-lo para não perder o rastreio da dívida.`);
       return;
    }
    
    if (confirm(`ATENÇÃO: Deseja realmente excluir o parceiro "${m.nome}" do sistema de forma permanente?`)) {
      try {
        await this.boloService.excluirMensalista(m.id);
      } catch (error) {
        console.error("Erro ao excluir mensalista:", error);
        alert("Falha ao excluir o parceiro.");
      }
    }
  }

  async abrirDetalhes(mensalista: any) {
    // Trava a rolagem da página de fundo (Scroll Bleed Fix)
    document.body.style.overflow = 'hidden';

    // Injeta um estado falso no histórico para interceptar o botão voltar do celular
    history.pushState({ modal: 'detalhes' }, '', window.location.href);
    this.modalAbertoViaHistory = true;

    this.mensalistaSelecionado = mensalista;
    this.abaModal = 'financeiro'; // Sempre abre no resumo
    this.valorPagoAgora = 0; // Reseta o input de pagamento
    this.valorPermuta = 0; // Reseta a permuta

    this.itensFaturaAberta = [];
    this.showModalDetalhes = true; // Exibe a tela vazia instantaneamente para fluidez

    try {
      // Faz a varredura das locações reais do parceiro direto no banco de dados
      const faturas = await this.boloService.getFaturasParceiro(mensalista.nome);
      
      this.itensFaturaAberta = faturas.map(f => ({
        idLoc: f.id,
        codigo: f.codigoReserva || 'MÚLTIPLOS',
        nomeBolo: f.nomeBolo,
        dataRetirada: f.dataRetiradaAcordada ? f.dataRetiradaAcordada.split('-').reverse().join('/') : 'N/A',
        dataDevolucao: f.dataDevolucaoAcordada ? f.dataDevolucaoAcordada.split('-').reverse().join('/') : 'N/A',
        valor: f.valorPendente || 0,
        // Traduz o status do sistema central para o visual do painel do parceiro
        status: f.status === 'entregue' || f.status === 'contrato_assinado' ? 'na_rua' : (f.status === 'finalizado' ? 'devolvido_pendente_pgto' : 'na_rua')
      }));
    } catch(error) {
      console.error("Erro técnico ao puxar as faturas reais do parceiro:", error);
    }
  }

  // ==========================================
  // LÓGICA DO CARRINHO (NOVA RESERVA)
  // ==========================================
  
  abrirNovaReserva(mensalista: any) {
    document.body.style.overflow = 'hidden';
    history.pushState({ modal: 'detalhes' }, '', window.location.href);
    this.modalAbertoViaHistory = true;

    this.mensalistaSelecionado = mensalista;
    this.abaModal = 'nova_reserva';
    this.carrinho = [];
    this.dadosReserva = { dataEvento: '', dataDevolucao: '', horarioRetirada: '', tipoLogistica: 'retirada', enderecoEntrega: '' };
    
    // Carrega o acervo de bolos para a Gê escolher e zera o filtro
    this.bolosDisponiveis$ = this.boloService.getBolos();
    this.textoBuscaCatalogo = '';
    this.termoBuscaCatalogo$.next('');
    
    // Pipeline reativo para filtro de busca do catálogo interno
    this.bolosFiltrados$ = combineLatest([this.bolosDisponiveis$, this.termoBuscaCatalogo$]).pipe(
      map(([bolos, termo]) => {
        if (!termo) return bolos;
        const t = termo.toLowerCase();
        return bolos.filter(b => 
          (b.nome?.toLowerCase() || '').includes(t) || 
          (b.codigo?.toLowerCase() || '').includes(t)
        );
      })
    );

    this.showModalDetalhes = true;
  }

  atualizarBuscaCatalogo() {
    this.termoBuscaCatalogo$.next(this.textoBuscaCatalogo);
  }

  adicionarAoCarrinho(bolo: any) {
    if (!this.carrinho.find(b => b.id === bolo.id)) {
      this.carrinho.push(bolo);
    }
  }

  removerDoCarrinho(index: number) {
    this.carrinho.splice(index, 1);
  }

  get totalCarrinho(): number {
    return this.carrinho.reduce((acc, bolo) => acc + (parseFloat(bolo.valorLocacao) || 0), 0);
  }

  async finalizarReservaMensalista() {
    if (!this.dadosReserva.dataEvento || this.carrinho.length === 0) {
      alert("Selecione pelo menos um bolo e a data do evento para prosseguir.");
      return;
    }

    this.loading = true;
    try {
      const payload = {
        cliente: {
          nome: this.mensalistaSelecionado.nome,
          whatsapp: this.mensalistaSelecionado.whatsapp,
          endereco: 'Endereço do Parceiro (Mensalista)',
          cpf: 'N/A'
        },
        bolos: this.carrinho, // Array Multi-Bolo injetado!
        nomeBolo: 'Combo Parceiro: ' + this.carrinho.map(b => b.nome).join(', '), // Fallback
        valorReferencia: this.totalCarrinho,
        valorTotalAcordado: this.totalCarrinho,
        valorPendente: this.totalCarrinho, // Fica 100% na conta/fatura do parceiro
        valorSinalAcordado: 0,
        valorSinalPago: 0,
        dataEvento: this.dadosReserva.dataEvento,
        dataRetiradaAcordada: this.dadosReserva.dataEvento,
        dataDevolucaoAcordada: this.dadosReserva.dataDevolucao,
        horarioRetirada: this.dadosReserva.horarioRetirada,
        tipoLogistica: this.dadosReserva.tipoLogistica,
        enderecoEntrega: this.dadosReserva.enderecoEntrega,
        valorEntrega: 0,
        tipoReserva: 'parceiro_mensalista'
      };

      // Passo 1: Salva a locação (O banco cria como 'aguardando_orcamento' por padrão)
      const docRef = await this.boloService.salvarLocacao(payload);

      // Passo 2: O Gatilho Mágico. Força o status para assinado para disparar o Webhook e gerar o PDF.
      await this.boloService.atualizarLocacao(docRef.id, { 
        status: 'contrato_assinado',
        assinaturaCliente: '' // Contrato validado internamente pela Gê
      });

      // Passo 3: Soma o custo desta locação à dívida total do Parceiro para atualizar a UI do Card
      await this.boloService.atualizarMensalista(this.mensalistaSelecionado.id, {
        saldoDevedor: (this.mensalistaSelecionado.saldoDevedor || 0) + this.totalCarrinho
      });

      alert("Reserva criada com sucesso! O sistema está gerando o contrato em PDF e enviará no WhatsApp do parceiro em instantes.");
      this.fecharModal();
    } catch (error) {
      console.error("Falha ao salvar carrinho do mensalista:", error);
      alert("Erro ao processar a reserva.");
    } finally {
      this.loading = false;
    }
  }

  async marcarComoDevolvido(item: any) {
    try {
      // Dá baixa na devolução do item no banco de dados principal
      await this.boloService.atualizarLocacao(item.idLoc, {
         status: 'finalizado',
         dataBaixaDevolucao: new Date().toLocaleString('pt-BR')
      });
      // Altera o visual do card na hora
      item.status = 'devolvido_pendente_pgto';
    } catch (error) {
      console.error("Erro ao registrar devolução", error);
    }
  }

  get totalFaturaAberta(): number {
    return this.itensFaturaAberta.reduce((acc, item) => acc + item.valor, 0);
  }

  get saldoRestante(): number {
    // Subtrai tanto o dinheiro real quanto o acordo de permuta
    const restante = this.totalFaturaAberta - this.valorPagoAgora - this.valorPermuta;
    return restante > 0 ? restante : 0;
  }

  async processarPagamento() {
    this.loading = true;
    try {
      const valorTotalPago = this.valorPagoAgora + this.valorPermuta;
      
      // 1. Atualiza a ficha do parceiro com o novo saldo restante
      await this.boloService.atualizarMensalista(this.mensalistaSelecionado.id, {
        saldoDevedor: this.saldoRestante
      });

      // 2. Se a fatura foi totalmente paga, mata a dívida nas locações ativas
      if (this.saldoRestante === 0) {
        for (let item of this.itensFaturaAberta) {
          await this.boloService.atualizarLocacao(item.idLoc, {
            status: 'pago',
            valorPendente: 0,
            valorAcertoFinal: item.valor
          });
        }
        alert('Fatura liquidada com sucesso! Todos os itens atrelados a ela foram marcados como Pagos na agenda central.');
      } else {
        // Se pagou só uma parte, o sistema abate do saldo global mas a locação continua aberta aguardando liquidação final.
        alert(`Acerto parcial de R$ ${valorTotalPago.toFixed(2)} recebido.\nFicará um saldo devedor de R$ ${this.saldoRestante.toFixed(2)} na ficha do parceiro.`);
      }
      
      this.fecharModal();
    } catch (error) {
      console.error("Erro ao baixar faturas:", error);
      alert("Falha técnica ao processar o pagamento do parceiro.");
    } finally {
      this.loading = false;
    }
  }

  fecharModal() {
    this.showModalDetalhes = false;
    // Destrava a rolagem da página de fundo ao sair
    document.body.style.overflow = '';
    
    // Limpa o estado falso da pilha de histórico caso o usuário feche pelo botão UI manualmente
    if (this.modalAbertoViaHistory) {
      this.modalAbertoViaHistory = false;
      history.back();
    }
  }

  // --- Funções de Máscara ---
  formatarMoedaVisor(valor: number): string {
    if (!valor && valor !== 0) return '';
    return valor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  aplicarMascaraMoeda(event: any) {
    let valorLimpo = event.target.value.replace(/\D/g, '');
    const numero = valorLimpo ? parseInt(valorLimpo, 10) / 100 : 0;
    this.valorPagoAgora = numero;
    event.target.value = this.formatarMoedaVisor(numero);
  }

  aplicarMascaraPermuta(event: any) {
    let valorLimpo = event.target.value.replace(/\D/g, '');
    const numero = valorLimpo ? parseInt(valorLimpo, 10) / 100 : 0;
    this.valorPermuta = numero;
    event.target.value = this.formatarMoedaVisor(numero);
  }
}