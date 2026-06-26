import { Component, inject, OnInit, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule, Router } from '@angular/router';
import { FormsModule } from '@angular/forms'; // ESSENCIAL PARA O [(ngModel)]
import { BoloService, Bolo } from '../services/bolo';
import { Observable, combineLatest } from 'rxjs';
import { map, tap } from 'rxjs/operators';
import { jsPDF } from 'jspdf';

@Component({
  selector: 'app-bolo-detalhe',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule], // FormsModule DEVE estar aqui
  templateUrl: './bolo-detalhe.html',
  styleUrl: '../app.css'
})
export class BoloDetalheComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private boloService = inject(BoloService);

  bolo$!: Observable<Bolo>;
  suportesCompativeis$!: Observable<Bolo[]>;
  suportesSelecionados: Bolo[] = [];
  suporteEmDestaque: Bolo | null = null;
  passo: 'verificar' | 'formulario' | 'contrato' | 'sucesso' = 'verificar';

  dataSelecionada: string = '';
  disponivel: boolean | null = null;
  carregando = false;

  dadosCliente = {
    nome: '',
    whatsapp: '',
    cpf: '',
    enderecoRua: '',
    enderecoNumero: '',
    enderecoBairro: '',
    enderecoCidade: 'Criciúma' // Facilita a vida da maioria, mas é editável
  };

  // Coleta Operacional (Logística da Cliente)
  horarioEscolhido: string = '';
  logisticaEscolhida: 'retirada' | 'entrega' = 'retirada';

  codigoGerado: string = ''; // Armazena o protocolo único

  todasImagens: string[] = [];
  imagemAtualIndex: number = 0;
  zoomViaHistory = false;
  suporteViaHistory = false;
  passosHistoryStack: string[] = [];

  @HostListener('window:popstate', ['$event'])
  onPopState(event: any) {
    // 1º Prioridade: Se houver imagem expandida (Zoom), fecha ela primeiro
    if (this.imagemExpandida) {
      this.imagemExpandida = null;
      this.zoomViaHistory = false;
    } 
    // 2º Prioridade: Se houver modal de suporte aberto, fecha ele
    else if (this.suporteEmDestaque) {
      this.suporteEmDestaque = null;
      this.suporteViaHistory = false;
    } 
    // 3º Prioridade: Se estiver avançado nos formulários, retrocede o passo de forma reativa
    else if (this.passosHistoryStack.length > 0) {
      this.passosHistoryStack.pop();
      this.passo = this.passosHistoryStack.length > 0 ? (this.passosHistoryStack[this.passosHistoryStack.length - 1] as any) : 'verificar';
      window.scrollTo(0, 0);
    }
  }

  obterTodasImagens(bolo: any): string[] {
    const imgs = [];
    if (bolo.imagemUrl) imgs.push(bolo.imagemUrl);
    if (bolo.imagemSecundaria) imgs.push(bolo.imagemSecundaria);
    if (bolo.galeria && bolo.galeria.length) imgs.push(...bolo.galeria);
    return [...new Set(imgs)].filter(Boolean); // Remove duplicadas
  }

  proximaImagem() {
    if (this.todasImagens.length > 0) {
      this.imagemAtualIndex = (this.imagemAtualIndex + 1) % this.todasImagens.length;
    }
  }

  imagemAnterior() {
    if (this.todasImagens.length > 0) {
      this.imagemAtualIndex = (this.imagemAtualIndex - 1 + this.todasImagens.length) % this.todasImagens.length;
    }
  }

  setImagem(index: number) {
    this.imagemAtualIndex = index;
  }

  imagemExpandida: string | null = null;
  touchStartX: number = 0;
  touchEndX: number = 0;

  // Motor de Swipe (Arrastar com o dedo no Mobile)
  onSwipeStart(event: TouchEvent) {
    this.touchStartX = event.changedTouches[0].screenX;
  }

  onSwipeEnd(event: TouchEvent) {
    this.touchEndX = event.changedTouches[0].screenX;
    this.handleSwipe();
  }

  handleSwipe() {
    const threshold = 50; // Distância mínima (em pixels) para considerar como arrasto
    if (this.touchStartX - this.touchEndX > threshold) {
      this.proximaImagem(); // Arrastou o dedo para a esquerda
    } else if (this.touchEndX - this.touchStartX > threshold) {
      this.imagemAnterior(); // Arrastou o dedo para a direita
    }
  }

  interagirComImagem(index: number) {
    if (this.imagemAtualIndex === index) {
      // Se a imagem já está na frente, abre o zoom
      this.imagemExpandida = this.todasImagens[index];
      history.pushState({ modal: 'zoom-detalhe' }, '');
      this.zoomViaHistory = true;
    } else {
      // Se a imagem está atrás, traz para a frente
      this.imagemAtualIndex = index;
    }
  }
  fecharImagemExpandida() {
    this.imagemExpandida = null;
    if (this.zoomViaHistory) {
      this.zoomViaHistory = false;
      history.back();
    }
  }

  // Motor Matemático do Efeito "Cartas na Mesa"
  getEstiloImagem(index: number): string {
    if (this.todasImagens.length <= 1) return 'z-30 scale-100 translate-x-0 opacity-100';

    const total = this.todasImagens.length;
    let diff = index - this.imagemAtualIndex;

    // Lógica para o baralho rodar em loop infinito
    if (diff < -1) diff += total;
    if (diff > 1) diff -= total;

    // Tratamento especial para quando o bolo só tem 2 fotos
    if (total === 2) {
      if (diff === 0) return 'z-30 rotate-0 scale-100 translate-x-0 translate-y-0 opacity-100 shadow-2xl';
      return 'z-20 rotate-3 scale-95 translate-x-[6%] translate-y-[2%] opacity-80 shadow-xl cursor-pointer hover:opacity-100 hover:translate-x-[8%] hover:rotate-6';
    }

    if (diff === 0) {
      // Foto do Topo (Frente)
      return 'z-30 rotate-0 scale-100 translate-x-0 translate-y-0 opacity-100 shadow-2xl';
    } else if (diff === 1) {
      // Foto da Direita (Atrás) - Inclinada
      return 'z-20 rotate-3 scale-95 translate-x-[6%] translate-y-[2%] opacity-80 shadow-xl cursor-pointer hover:opacity-100 hover:rotate-6 hover:translate-x-[8%]';
    } else if (diff === -1) {
      // Foto da Esquerda (Atrás) - Inclinada
      return 'z-20 -rotate-3 scale-95 -translate-x-[6%] translate-y-[2%] opacity-80 shadow-xl cursor-pointer hover:opacity-100 hover:-rotate-6 hover:-translate-x-[8%]';
    } else {
      // Fotos extras (Escondidas no fundo do baralho)
      return 'z-0 rotate-0 scale-75 translate-x-0 translate-y-[5%] opacity-0 pointer-events-none';
    }
  }

  ngOnInit() {
    const id = this.route.snapshot.paramMap.get('id');
    if (id) {
      // Usamos o operador 'tap' para extrair as fotos assim que os dados do bolo chegam do banco
      this.bolo$ = this.boloService.getBoloById(id).pipe(
        tap(bolo => {
          this.todasImagens = this.obterTodasImagens(bolo);
          this.imagemAtualIndex = 0;
        })
      );
      
      // Pipeline reativo cruzado extraindo da mesma coleção raiz
      this.suportesCompativeis$ = combineLatest([
        this.boloService.getBolos(),
        this.bolo$
      ]).pipe(
        map(([allSuportes, bolo]) => {
          const compativeis = (bolo as any).boleirasCompativeis || [];
          return allSuportes.filter(s => compativeis.includes(s.id));
        })
      );
    }
  }

  toggleSuporte(suporte: Bolo) {
    const idx = this.suportesSelecionados.findIndex(s => s.id === suporte.id);
    if (idx > -1) {
      this.suportesSelecionados.splice(idx, 1);
    } else {
      this.suportesSelecionados.push(suporte);
    }
  }

  isSuporteSelecionado(id: string): boolean {
    return this.suportesSelecionados.some(s => s.id === id);
  }

  abrirFotoSuporte(suporte: Bolo, event: Event) {
    event.stopPropagation(); // Impede que o clique na foto selecione o suporte acidentalmente
    this.suporteEmDestaque = suporte;
    history.pushState({ modal: 'suporte-detalhe' }, '');
    this.suporteViaHistory = true;
  }

  fecharFotoSuporte() {
    this.suporteEmDestaque = null;
    if (this.suporteViaHistory) {
      this.suporteViaHistory = false;
      history.back();
    }
  }

  async verificarDisponibilidade() {
    if (!this.dataSelecionada) return;
    this.carregando = true;
    const id = this.route.snapshot.paramMap.get('id');
    this.disponivel = await this.boloService.verificarDisponibilidade(id!, this.dataSelecionada);
    this.carregando = false;
  }

  proximoPasso(p: 'verificar' | 'formulario' | 'contrato') {
    // Interceptação inteligente: se o cliente clicar em voltar nos botões da tela, aciona a pilha nativa do histórico
    if (p === 'verificar' && this.passo === 'formulario') {
      history.back();
      return;
    }
    if (p === 'formulario' && this.passo === 'contrato') {
      history.back();
      return;
    }

    this.passo = p;
    window.scrollTo(0, 0);
    history.pushState({ passo: p }, '');
    this.passosHistoryStack.push(p);
  }

  async finalizarReserva(bolo: Bolo) {
    this.carregando = true;
    try {
      // Gera um código de 6 caracteres alfanuméricos (Ex: K9B2X1)
      this.codigoGerado = Math.random().toString(36).substring(2, 8).toUpperCase();

      // Formata o endereço removendo vírgulas, pontos e traços para forçar a busca livre (Free-Form) na API
      const enderecoFormatadoApi = this.logisticaEscolhida === 'entrega'
  ? `${this.dadosCliente.enderecoRua.trim()} ${this.dadosCliente.enderecoNumero.trim()} ${this.dadosCliente.enderecoBairro.trim()} ${this.dadosCliente.enderecoCidade.trim()} SC Brasil`
      .replace(/[.,-]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  : '';

      // Cálculo do montante base unificado (Bolo + Suportes selecionados)
      const valorSuportesAdicionais = this.suportesSelecionados.reduce((acc, s) => acc + (s.valorLocacao || 0), 0);
      const valorBaseGlobal = (bolo.valorLocacao || 0) + valorSuportesAdicionais;

      // Mapeia os sub-itens no formato esperado pela listagem múltipla do painel gerencial
      const itensCombo = [
        { id: bolo.id, nomeBolo: bolo.nome },
        ...this.suportesSelecionados.map(s => ({ id: s.id, nomeBolo: s.nome }))
      ];

      const locacao = {
        codigoReserva: this.codigoGerado,
        idBolo: bolo.id,
        nomeBolo: bolo.nome,
        bolos: itensCombo, // Injeção do array de itens agrupados para exibição de chips
        valorReferencia: valorBaseGlobal, // Soma global que alimenta o motor financeiro 50/50 do admin
        dataEvento: this.dataSelecionada,
        horarioRetirada: this.horarioEscolhido,
        tipoLogistica: this.logisticaEscolhida,
        cliente: {
          nome: this.dadosCliente.nome,
          whatsapp: this.dadosCliente.whatsapp,
          cpf: this.dadosCliente.cpf,
          endereco: enderecoFormatadoApi
        },
        status: 'pendente_pagamento'
      };
      await this.boloService.salvarLocacao(locacao);

      // Avança direto para a tela de sucesso sem redirecionar
      this.passo = 'sucesso';
    } catch (error) {
      alert("Erro ao processar a reserva.");
    } finally {
      this.carregando = false;
    }
  }
}
