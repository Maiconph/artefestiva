import { Component, inject, OnInit, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule, Router } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Firestore, collection, addDoc } from '@angular/fire/firestore';
import { BoloService } from '../services/bolo';
import { Observable, BehaviorSubject, combineLatest, Subject } from 'rxjs';
import { map, debounceTime } from 'rxjs/operators';
import { jsPDF } from 'jspdf';
import { MensalistasComponent } from '../mensalistas/mensalistas';
import { WhatsappConfig } from '../whatsapp/whatsapp';
import { CobrancaComponent } from '../cobranca/cobranca';
import { FinanceiroComponent } from '../financeiro/financeiro';

@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, MensalistasComponent, WhatsappConfig, CobrancaComponent, FinanceiroComponent],
  templateUrl: './admin.html',
  styleUrl: '../app.css'
})
export class AdminComponent implements OnInit {
  private boloService = inject(BoloService);
  private router = inject(Router);
  private sanitizer = inject(DomSanitizer);
  private firestore = inject(Firestore);

  // Controle de PDV Manual (Nova Reserva Rápida)
  todosOsBolos: any[] = [];
  showModalNovaReserva = false;
  dadosNovaReserva = { 
    bolosSelecionados: [] as any[], 
    dataEvento: '', 
    horarioAjustado: '', 
    tipoLogistica: 'retirada', 
    endereco: '', 
    nome: '', 
    whatsapp: '', 
    cpf: '',
    buscaBolo: '',
    anotadoACaneta: false,
    statusDestino: 'pago'
  };

  toggleBoloPDV(bolo: any) {
    const idx = this.dadosNovaReserva.bolosSelecionados.findIndex((b: any) => b.id === bolo.id);
    if (idx > -1) {
      this.dadosNovaReserva.bolosSelecionados.splice(idx, 1);
    } else {
      this.dadosNovaReserva.bolosSelecionados.push(bolo);
    }
  }

  isBoloSelecionadoPDV(id: string): boolean {
    return this.dadosNovaReserva.bolosSelecionados.some((b: any) => b.id === id);
  }

  /**
   * Recupera os dados completos de código e valor unitário de uma peça do acervo para renderização na lista
   */
  obterItemCompleto(b: any): any {
    if (b.codigo && b.valorLocacao !== undefined) return b;
    const encontrado = this.todosOsBolos.find(item => item.id === b.id);
    return encontrado || { codigo: 'S/C', valorLocacao: 0 };
  }

  // Configuração da Assinatura (Fase 3) - Futuramente movido para configurações dinâmicas
  assinaturaGeUrl = 'https://firebasestorage.googleapis.com/v0/b/arte-festiva-atelie.firebasestorage.app/o/assinaturas_ge%2Fassinatura.png?alt=media&token=7f209bc5-f308-4f9f-8008-b35df7d15ccb';

  // Helper assíncrono para converter URL em Base64 e blindar o gerador contra bloqueios de CORS
  private async carregarImagemBase64(url: string): Promise<string> {
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.readAsDataURL(blob);
      });
    } catch (e) {
      console.error("Erro ao carregar imagem para o PDF", e);
      return '';
    }
  }

  // Controle de Abas
  tipoCadastro: 'financeiro' | 'bolo' | 'boleira' | 'banner' | 'agenda' | 'orcamentos' | 'mensalistas' | 'whatsapp' | 'cobranca' = 'agenda';

  // Objetos de Cadastro
  novaBoleira: any = { nome: '', contato: '', regiao: '' };
  // Observables de Dados
  locacoes$!: Observable<any[]>;
  locacoesAgrupadas$!: Observable<any[]>;
  orcamentos$!: Observable<any[]>;
  bolos$!: Observable<any[]>; // Escuta o acervo genérico
  bolosFiltrados$!: Observable<any[]>; // Escuta o acervo pós-filtro
  suportes$!: Observable<any[]>;

  // Controle de Busca Reativa (Acervo)
  termoBusca$ = new BehaviorSubject<string>('');
  textoBusca = ''; // Bind do input HTML

  // Controle de Expansão do Acervo (Master-Detail)
  boloExpandido: string | null = null;

  toggleBoloExpandido(id: string) {
    this.boloExpandido = this.boloExpandido === id ? null : id;
  }

  // Controle de Busca Reativa (Agenda)
  termoBuscaAgenda$ = new BehaviorSubject<string>('');
  textoBuscaAgenda = ''; 

  // Controle de Expansão da Agenda
  diaExpandido: string | null = null;

  // Controle do Mapa Dinâmico
  urlMapaSegura: SafeResourceUrl | null = null;
  enderecoDebouncer = new Subject<string>();
  mensagemEnderecoNaoEncontrado = false;

  // Estado do Modal de Fechamento
  showModal = false;
  locacaoSelecionada: any = null;
  modalAdminAbertoViaHistory = false; // Controle de Histórico Mobile

  @HostListener('window:popstate', ['$event'])
  onPopState(event: any) {
    if (this.showModal) {
      this.fecharModalContrato();
    } else if (this.showModalAcerto) {
      this.fecharModalAcerto();
    }
  }

  fecharModalContrato() {
    this.showModal = false;
    if (this.modalAdminAbertoViaHistory) {
      this.modalAdminAbertoViaHistory = false;
      history.back();
    }
  }

  fecharModalAcerto() {
    this.showModalAcerto = false;
    if (this.modalAdminAbertoViaHistory) {
      this.modalAdminAbertoViaHistory = false;
      history.back();
    }
  }

  // Objeto de dados para o Contrato Final
  dadosFechamento = {
    dataRetirada: '',
    dataDevolucao: '',
    horarioAjustado: '',
    formaPagamento: 'Pix',
    valorTotal: 0,
    valorSinal: 0,
    valorRetirada: 0,
    valorReposicao: 0,
    tipoLogistica: 'retirada', // 'retirada' ou 'entrega'
    enderecoEntrega: '',
    valorEntrega: 0,
    valorPorKm: 3.50, // Valor padrão inicial por KM rodado
    kmDistancia: 0
  };

  // Lista matriz de categorias para iteração
  listaCategorias = ['Casamento', 'Infantil', '15 Anos', 'Batizado', 'Noivado', 'Aniversário', 'Velas e Topos', 'Suportes e Boleiras'];

  // Objetos de Cadastro
  novoBolo: any = { codigo: '', nome: '', categoria: ['Casamento'], valorLocacao: 0, descricao: '', boleirasCompativeis: [] };
  novoBanner: any = { title: '', subtitle: '', imageUrl: '' };

  toggleCategoriaNovoBolo(cat: string) {
    if (!Array.isArray(this.novoBolo.categoria)) {
      this.novoBolo.categoria = this.novoBolo.categoria ? [this.novoBolo.categoria] : [];
    }
    const idx = this.novoBolo.categoria.indexOf(cat);
    if (idx > -1) this.novoBolo.categoria.splice(idx, 1);
    else this.novoBolo.categoria.push(cat);
  }

  toggleCategoriaNoBolo(bolo: any, cat: string) {
    if (!Array.isArray(bolo.categoria)) {
      bolo.categoria = bolo.categoria ? [bolo.categoria] : [];
    }
    const idx = bolo.categoria.indexOf(cat);
    if (idx > -1) bolo.categoria.splice(idx, 1);
    else bolo.categoria.push(cat);
  }

  exibirCategorias(cat: any): string {
    if (Array.isArray(cat)) return cat.join(', ');
    return cat || 'Sem Categoria';
  }

  toggleBoleiraNoNovoBolo(id: string) {
    if (!this.novoBolo.boleirasCompativeis) this.novoBolo.boleirasCompativeis = [];
    const idx = this.novoBolo.boleirasCompativeis.indexOf(id);
    if (idx > -1) {
      this.novoBolo.boleirasCompativeis.splice(idx, 1);
    } else {
      this.novoBolo.boleirasCompativeis.push(id);
    }
  }

  toggleBoleiraNoBolo(bolo: any, id: string) {
    if (!bolo.boleirasCompativeis) bolo.boleirasCompativeis = [];
    const idx = bolo.boleirasCompativeis.indexOf(id);
    if (idx > -1) {
      bolo.boleirasCompativeis.splice(idx, 1);
    } else {
      bolo.boleirasCompativeis.push(id);
    }
  }

  fileToUpload: File | null = null;
  loading = false;

  ngOnInit() {
    this.carregarDados();

    // Inscreve o debouncer para aguardar o usuário parar de digitar (800ms) antes de renderizar o iframe e calcular preço por KM
    this.enderecoDebouncer.pipe(debounceTime(800)).subscribe(async (endereco) => {
      if (!endereco || endereco.trim() === '') {
        this.urlMapaSegura = null;
        // IMPORTANTE: A distância não é mais zerada aqui para proteger a sua digitação manual!
        return;
      }
      
      // URL oficial e 100% blindada do Google Maps Embed (Mata os erros de CSP e JSON)
      const url = `https://maps.google.com/maps?q=${encodeURIComponent(endereco)}&t=m&z=16&output=embed&iwloc=near`;
      this.urlMapaSegura = this.sanitizer.bypassSecurityTrustResourceUrl(url);

      // Motor de cálculo de logística automático com Fallback Inteligente (Bairro/Cidade)
      try {
        // TENTATIVA 1: Busca Livre Completa (Rua, Número, Bairro, Cidade)
        const enderecoBuscaLivre = `${endereco} Santa Catarina Brasil`.replace(/[.,-]/g, ' ').replace(/\s+/g, ' ').trim();
        
        let geoRes = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(enderecoBuscaLivre)}&countrycodes=br&format=jsonv2&addressdetails=1&limit=1`, {
          headers: { 'User-Agent': 'ArteFestivaAtelie-App-2026' }
        });
        let geoData = await geoRes.json();

        // TENTATIVA 2: Fallback Bairro + Cidade (Extrai apenas o que vem depois do último número)
        if (!geoData || geoData.length === 0) {
           let fallbackQuery = '';
           // Acha o último número no endereço (ex: o número da casa)
           const ultimoNumero = endereco.match(/\d+(?!.*\d)/);
           
           if (ultimoNumero && ultimoNumero.index !== undefined) {
               // Pega tudo o que vem DEPOIS do último número (Geralmente Bairro e Cidade)
               fallbackQuery = endereco.substring(ultimoNumero.index + ultimoNumero[0].length).replace(/[.,-]/g, ' ').trim();
           } else if (endereco.includes(',')) {
               // Se não tiver número, mas tiver vírgula, tenta pegar as duas últimas partes
               const parts = endereco.split(',');
               fallbackQuery = `${parts[parts.length - 2] || ''} ${parts[parts.length - 1]}`.trim();
           }

           if (fallbackQuery && fallbackQuery.length > 3) {
               const queryFinal = `${fallbackQuery} Santa Catarina Brasil`.replace(/\s+/g, ' ').trim();
               console.log('Rua exata não encontrada. Tentando Fallback por Bairro/Cidade:', queryFinal);
               
               geoRes = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(queryFinal)}&countrycodes=br&format=jsonv2&addressdetails=1&limit=1`, {
                  headers: { 'User-Agent': 'ArteFestivaAtelie-App-2026' }
               });
               geoData = await geoRes.json();
           }
        }

        if (geoData && geoData.length > 0) {
          this.mensagemEnderecoNaoEncontrado = false; // Desliga o aviso se achar
          const destLat = geoData[0].lat;
          const destLon = geoData[0].lon;
          
          // Coordenadas fixas de Partida do Ateliê: Av. Luiz Lazzarin, 730
          const startLat = -28.694611;
          const startLon = -49.400556;

          // Consome a API do OSRM para traçar rota
          const routeRes = await fetch(`https://router.project-osrm.org/route/v1/driving/${startLon},${startLat};${destLon},${destLat}?overview=false`);
          const routeData = await routeRes.json();

          if (routeData.routes && routeData.routes.length > 0) {
            const metros = routeData.routes[0].distance;
            // Multiplica a distância por 2 para trajeto completo (Ida e Volta)
            this.dadosFechamento.kmDistancia = parseFloat(((metros / 1000) * 2).toFixed(1));
            this.recalcularTotalEntrega();
          }
        } else {
          // Ativa o feedback visual no HTML sem bloquear a tela (O Fallback também falhou)
          this.mensagemEnderecoNaoEncontrado = true;
          console.warn("API não encontrou as coordenadas nem pelo endereço exato, nem pelo fallback de bairro. Campo liberado para KM manual.");
        }
      } catch (err) {
        console.error("Erro interno no motor de rotas geográficas:", err);
      }
    });
  }

  carregarDados() {
    this.locacoes$ = this.boloService.getLocacoes();
    this.orcamentos$ = this.boloService.getOrcamentos();
    this.bolos$ = this.boloService.getBolos(); // Carrega o catálogo completo
    
    // Filtra cirurgicamente os suportes a partir da coleção raiz
    this.suportes$ = this.bolos$.pipe(map(bolos => bolos.filter(b => b.categoria === 'Suportes e Boleiras')));

    // Alimenta uma cópia síncrona do catálogo para buscas ultrarrápidas no modal de PDV
    this.bolos$.subscribe(b => this.todosOsBolos = b);

    // Pipeline reativo para filtro de busca do acervo
    this.bolosFiltrados$ = combineLatest([this.bolos$, this.termoBusca$]).pipe(
      map(([bolos, termo]) => {
        if (!termo) return bolos;
        const t = termo.toLowerCase();
        return bolos.filter(b => {
          // Checagem de segurança para suportar dados legados
          const matchCategoria = Array.isArray(b.categoria) 
            ? b.categoria.some((c: string) => c.toLowerCase().includes(t))
            : (b.categoria?.toLowerCase() || '').includes(t);

          return (b.nome?.toLowerCase() || '').includes(t) || 
                 (b.codigo?.toLowerCase() || '').includes(t) || 
                 matchCategoria;
        });
      })
    );

    // Pipeline reativo e agrupamento lógico da Agenda
    this.locacoesAgrupadas$ = combineLatest([this.locacoes$, this.termoBuscaAgenda$]).pipe(
      map(([locacoes, termo]) => {
        let locacoesProcessadas = locacoes;

        // Motor de filtro com Múltiplos Alvos
        if (termo) {
          const t = termo.toLowerCase();
          
          if (t === '@pendente_devolucao') {
            // Meta-Filtro Cirúrgico: Pega o que está com o cliente (entregue) E a data de devolução já passou (atrasado)
            const formatterBR = new Intl.DateTimeFormat('fr-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
            const hojeIso = formatterBR.format(new Date());
            
            locacoesProcessadas = locacoes.filter(loc => 
              loc.status === 'entregue' && loc.dataDevolucaoAcordada && loc.dataDevolucaoAcordada < hojeIso
            );
          } else {
            locacoesProcessadas = locacoes.filter(loc => {
              // Extrai nomes múltiplos caso seja uma reserva de parceiro/carrinho
              const nomesBolos = loc.bolos ? loc.bolos.map((b: any) => b.nomeBolo || b.nome).join(' ') : (loc.nomeBolo || '');
              
              return (loc.cliente?.nome?.toLowerCase() || '').includes(t) ||
                     (loc.cliente?.whatsapp?.toLowerCase() || '').includes(t) ||
                     nomesBolos.toLowerCase().includes(t) ||
                     (loc.codigoReserva?.toLowerCase() || loc.codigo?.toLowerCase() || loc.codigoBolo?.toLowerCase() || '').includes(t) ||
                     (loc.status?.toLowerCase().replace('_', ' ') || '').includes(t);
            });
          }
        }

        const diasSemana = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
        const meses = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

        // Blindagem de Fuso Horário (Trava o calendário no fuso de SC/Brasília para cálculos exatos)
        const formatterBR = new Intl.DateTimeFormat('fr-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
        const hojeIso = formatterBR.format(new Date());
        
        const dataAmanha = new Date();
        dataAmanha.setDate(dataAmanha.getDate() + 1);
        const amanhaIso = formatterBR.format(dataAmanha);

        // Agrupamento paramétrico sobre as locações já filtradas
        const grupos = locacoesProcessadas.reduce((acc: any, loc) => {
          const data = loc.dataEvento; 
          if (!acc[data]) {
            const dataObj = new Date(data + 'T12:00:00'); 
            
            let nivelUrgencia = 'normal';
            if (data === hojeIso) nivelUrgencia = 'hoje';
            else if (data === amanhaIso) nivelUrgencia = 'amanha';

            acc[data] = {
              dataString: data,
              dataObj: dataObj,
              diaNumero: dataObj.getDate().toString().padStart(2, '0'),
              diaSemana: diasSemana[dataObj.getDay()],
              mes: meses[dataObj.getMonth()],
              urgencia: nivelUrgencia, // Injeção do Estado de Semaforização
              locacoes: []
            };
          }
          acc[data].locacoes.push(loc);
          return acc;
        }, {});

        // Algoritmo de Ordenação Híbrido: Ordem cronológica, mas injeta "Hoje" no topo prioritário
        return Object.values(grupos).sort((a: any, b: any) => {
           if (a.urgencia === 'hoje' && b.urgencia !== 'hoje') return -1;
           if (b.urgencia === 'hoje' && a.urgencia !== 'hoje') return 1;
           return a.dataObj.getTime() - b.dataObj.getTime();
        });
      })
    );
  }

  toggleDia(dataString: string) {
    this.diaExpandido = this.diaExpandido === dataString ? null : dataString;
  }

  // ==========================================
  // LÓGICA DO PDV (NOVA RESERVA MANUAL)
  // ==========================================

  get bolosModalFiltrados() {
    const t = this.dadosNovaReserva.buscaBolo.toLowerCase();
    if (!t) return this.todosOsBolos.slice(0, 50); // Limita para não pesar a renderização inicial
    return this.todosOsBolos.filter(b => b.nome.toLowerCase().includes(t) || (b.codigo||'').toLowerCase().includes(t));
  }

  abrirModalNovaReserva() {
    this.dadosNovaReserva = { 
      bolosSelecionados: [] as any[], 
      dataEvento: '', 
      horarioAjustado: '', 
      tipoLogistica: 'retirada', 
      endereco: '', 
      nome: '', 
      whatsapp: '', 
      cpf: '',
      buscaBolo: '',
      anotadoACaneta: false,
      statusDestino: 'pago'
    };
    this.showModalNovaReserva = true;
  }

  async criarReservaEAvancar() {
    this.loading = true;
    try {
        const codigoGerado = Math.random().toString(36).substring(2, 8).toUpperCase();
        
        // Cálculo do valor global e construção do array de itens para o combo
        const itensSelecionados = this.dadosNovaReserva.bolosSelecionados;
        const valorBaseGlobal = itensSelecionados.reduce((acc: number, b: any) => acc + (b.valorLocacao || 0), 0);
        const itensCombo = itensSelecionados.map((b: any) => ({ 
          id: b.id, 
          nomeBolo: b.nome,
          codigo: b.codigo || '',
          valorLocacao: b.valorLocacao || 0
        }));
        
        // Usa o primeiro item como "Peça Principal" para efeito de ID de referência
        const nomePrincipal = itensSelecionados.length > 0 ? itensSelecionados[0].nome : '';
        const idPrincipal = itensSelecionados.length > 0 ? itensSelecionados[0].id : '';

        // Emula perfeitamente os dados como se a cliente tivesse preenchido no site
        const novaLocacao: any = {
            codigoReserva: codigoGerado,
            idBolo: idPrincipal,
            nomeBolo: nomePrincipal,
            bolos: itensCombo, // Injeta o array de múltiplos itens para visualização no painel
            valorReferencia: valorBaseGlobal,
            dataEvento: this.dadosNovaReserva.dataEvento,
            horarioRetirada: this.dadosNovaReserva.horarioAjustado,
            tipoLogistica: this.dadosNovaReserva.tipoLogistica,
            cliente: {
                nome: this.dadosNovaReserva.nome,
                whatsapp: this.dadosNovaReserva.whatsapp,
                cpf: this.dadosNovaReserva.cpf,
                endereco: this.dadosNovaReserva.endereco
            },
            status: this.dadosNovaReserva.anotadoACaneta ? this.dadosNovaReserva.statusDestino : 'aguardando_orcamento', // Força a necessidade do Orçamento/Link ou status direto
            dataCriacao: new Date().toISOString()
        };

        // Regras para injeção e blindagem contábil retroativa se anotado a caneta estiver ativo
        if (this.dadosNovaReserva.anotadoACaneta) {
            novaLocacao.registroHistorico = true;
            novaLocacao.silenciarNotificacoes = true;
            novaLocacao.valorTotalAcordado = valorBaseGlobal;
            novaLocacao.valorSinalAcordado = valorBaseGlobal / 2;
            novaLocacao.valorSinalPago = valorBaseGlobal;
            novaLocacao.valorPendente = 0;
            
            const agoraLog = new Date().toLocaleString('pt-BR');
            if (this.dadosNovaReserva.statusDestino === 'entregue') {
                novaLocacao.dataBaixaEntrega = agoraLog;
            } else if (this.dadosNovaReserva.statusDestino === 'finalizado') {
                novaLocacao.dataBaixaEntrega = agoraLog;
                novaLocacao.dataBaixaDevolucao = agoraLog;
            }
        }

        // Salva silenciosamente no Firebase
        const locacoesRef = collection(this.firestore, 'locacoes');
        const docRef = await addDoc(locacoesRef, novaLocacao);
        
        this.showModalNovaReserva = false;
        
        if (!this.dadosNovaReserva.anotadoACaneta) {
            // Constrói o objeto com o ID gerado pelo banco para o sistema continuar a leitura
            const locacaoParaModal = { id: docRef.id, ...novaLocacao };
            // O PULO DO GATO: Abre a tela de Emissão de Orçamento automaticamente!
            this.abrirModalPagamento(locacaoParaModal);
        } else {
            alert("✅ Contrato retroativo inserido no sistema com sucesso (todas as notificações automáticas foram blindadas)!");
        }
    } catch (error) {
        console.error("Erro ao criar reserva PDV:", error);
        alert("Falha técnica ao iniciar a pré-reserva manual.");
    } finally {
        this.loading = false;
    }
  }

  // --- LÓGICA DO CONTRATO E MODAL ---

  abrirModalPagamento(loc: any) {
    this.locacaoSelecionada = loc;
    const enderecoSugerido = loc.cliente?.endereco || '';

    const valorBase = parseFloat(loc.valorReferencia) || 0;
    const metadeCalculada = valorBase / 2;

    /// Reseta os campos para o novo contrato com split 50/50 dinâmico
    this.dadosFechamento = {
      dataRetirada: loc.dataEvento || '', // Auto-fill da data selecionada pela cliente
      dataDevolucao: '',
      horarioAjustado: loc.horarioRetirada || '', // Auto-fill do horário escolhido
      formaPagamento: 'Pix',
      valorTotal: valorBase,
      valorSinal: metadeCalculada,
      valorRetirada: metadeCalculada,
      valorReposicao: 450, // Valor padrão de exemplo
      tipoLogistica: loc.tipoLogistica || 'retirada', // Auto-fill da logística escolhida
      enderecoEntrega: enderecoSugerido, // Traz o endereço do cliente como sugestão
      valorEntrega: 0,
      valorPorKm: 3.50,
      kmDistancia: 0
    };

    // Dispara o mapa imediatamente se houver endereço salvo
    if (enderecoSugerido) {
      this.onEnderecoChange(enderecoSugerido);
    } else {
      this.urlMapaSegura = null;
    }

    history.pushState({ modal: 'contrato' }, '', window.location.href);
    this.modalAdminAbertoViaHistory = true;

    this.showModal = true;
  }

  // Calcula matematicamente o saldo restante
  calcularValores(recalcularSinal: boolean = false) {
    // Soma o valor da locação com a taxa de entrega (se a modalidade for entrega)
    const total = (this.dadosFechamento.valorTotal || 0) + (this.dadosFechamento.tipoLogistica === 'entrega' ? (this.dadosFechamento.valorEntrega || 0) : 0);
    
    // Auto-ajusta o sinal para 50% do total global caso o cenário mude (mantendo a edição manual livre)
    if (recalcularSinal) {
      this.dadosFechamento.valorSinal = total / 2;
    }

    const sinal = this.dadosFechamento.valorSinal || 0;
    // Math.max evita que o saldo fique negativo caso o sinal seja digitado maior que o total
    this.dadosFechamento.valorRetirada = Math.max(0, total - sinal);
  }

  // Monitora e calcula a porcentagem de desconto ou acréscimo
  get porcentagemDesconto(): number {
    const base = parseFloat(this.locacaoSelecionada?.valorReferencia) || 0;
    const total = this.dadosFechamento.valorTotal || 0;
    if (base <= 0 || total === base) return 0; // Só zera se for exatamente o mesmo preço
    return ((base - total) / base) * 100;
  }

  // Retorna a soma real (Valor Praticado + Taxa de Entrega se aplicável)
  get totalGeral(): number {
    const locacao = this.dadosFechamento.valorTotal || 0;
    const entrega = this.dadosFechamento.tipoLogistica === 'entrega' ? (this.dadosFechamento.valorEntrega || 0) : 0;
    return locacao + entrega;
  }

  onEnderecoChange(endereco: string) {
    // Envia o texto digitado para o canal de debounce, evitando re-renderização em loop no HTML
    this.enderecoDebouncer.next(endereco);
  }

  recalcularTotalEntrega() {
    this.dadosFechamento.valorEntrega = (this.dadosFechamento.kmDistancia || 0) * (this.dadosFechamento.valorPorKm || 0);
    this.calcularValores(true); // Repassa a instrução para reajustar o sinal
  }

  async gerarContratoFinal(ehApenasOrcamento: boolean = false) {
    if (!this.locacaoSelecionada) return;

    const nomeLimpo = this.locacaoSelecionada.cliente.nome.normalize('NFD').replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "_");

    // Só processamos a biblioteca jsPDF localmente se for um fechamento final.
    // Orçamentos geram PDFs automaticamente via Motor no Backend (Cloud Functions).
    if (!ehApenasOrcamento) {
      const doc = new jsPDF();
      const margin = 20;
      const pageWidth = 170; // Largura útil da folha A4 com margens de 20mm
      let y = 25;

      // Configuração inicial da fonte para um ar mais jurídico
      doc.setFont("times", "normal");

    // Texto limpo e contínuo para evitar quebras de linha precoces
    const contratoTexto = `CONTRATO DE LOCAÇÃO DE BOLO CENOGRÁFICO

Pelo presente instrumento particular, de um lado: GERUZA PERUCHI DA ROSA, inscrita no CNPJ nº 45.439.303/0001-43, CPF nº 035.858.049-85, com nome fantasia ARTE FESTIVA ATELIÊ, estabelecida na Av. Luiz Lazzarin, Vila Floresta II, nº 730, sala 2, Criciúma/SC, doravante denominada CONTRATADA.

E de outro lado: ${this.locacaoSelecionada.cliente.nome.toUpperCase()}, CPF nº ${this.locacaoSelecionada.cliente.cpf}, residente e domiciliado(a) em ${this.locacaoSelecionada.cliente.endereco.toUpperCase()}, doravante denominado(a) CONTRATANTE.

As partes firmam o presente contrato mediante as seguintes cláusulas:

CLÁUSULA 1 - DO OBJETO
1.1. O presente contrato tem por objeto a locação de itens decorativos de propriedade da LOCADORA, conforme especificação abaixo:
Item: ${this.locacaoSelecionada.nomeBolo}
Descrição: Peça decorativa em biscuit feita manualmente.
Tema: ${this.locacaoSelecionada.tema || 'Conforme Catálogo'}
Quantidade: 01
Data do Evento: ${this.locacaoSelecionada.dataEvento}

1.2. Os itens destinam-se exclusivamente à finalidade decorativa, sendo expressamente proibido uso diverso, consumo, modificação estrutural ou qualquer alteração sem autorização da CONTRATADA.

CLÁUSULA 2 - DO PRAZO E LOGÍSTICA
Modalidade: ${this.dadosFechamento.tipoLogistica === 'entrega' ? 'ENTREGA NO LOCAL' : 'RETIRADA NO ATELIÊ'}
${this.dadosFechamento.tipoLogistica === 'entrega' ? `Endereço de Entrega: ${this.dadosFechamento.enderecoEntrega}` : `Data de retirada: ${this.dadosFechamento.dataRetirada}`}
Data de devolução: ${this.dadosFechamento.dataDevolucao}
Horário ajustado: ${this.dadosFechamento.horarioAjustado}

2.1. ${this.dadosFechamento.tipoLogistica === 'entrega' ? 'A entrega será realizada pela CONTRATADA no endereço especificado acima mediante taxa de deslocamento acordada.' : 'A retirada e devolução ocorrerão no endereço da CONTRATADA, sendo responsabilidade exclusiva do CONTRATANTE.'}
2.2. A não devolução na data estipulada implicará multa de 10% sobre o valor total da locação, sem prejuízo de outras penalidades previstas neste contrato.

CLÁUSULA 3 - DO VALOR E DO PAGAMENTO
3.1. O valor total do serviço é de R$ ${(this.dadosFechamento.valorTotal + (this.dadosFechamento.tipoLogistica === 'entrega' ? this.dadosFechamento.valorEntrega : 0)).toFixed(2)} ${this.dadosFechamento.tipoLogistica === 'entrega' ? `(Incluso R$ ${this.dadosFechamento.valorEntrega.toFixed(2)} referentes à taxa de entrega)` : ''}
3.2. O pagamento será realizado da seguinte forma:
R$ ${this.dadosFechamento.valorSinal.toFixed(2)} a título de sinal/reserva, no ato do agendamento;
R$ ${this.dadosFechamento.valorRetirada.toFixed(2)} na data da retirada do item locado.
Forma de pagamento: ${this.dadosFechamento.formaPagamento}

3.3. A reserva somente será confirmada mediante o pagamento do sinal.
3.4. O não pagamento da parcela final na data da retirada implicará rescisão automática do contrato, com retenção do sinal pago.

CLÁUSULA 4 - DAS OBRIGAÇÕES DA CONTRATADA
4.1. Entregar o(s) item(ns) locado(s) na data ajustada, em perfeito estado de conservação e limpeza.
4.2. Prestar informações necessárias quanto ao correto manuseio e conservação do material.
4.3. Disponibilizar item compatível com o contratado, conforme especificação constante neste instrumento.

CLÁUSULA 5 - DAS OBRIGAÇÕES DO CONTRATANTE
5.1. Retirar e devolver os itens nas datas ajustadas.
5.2. Efetuar o pagamento integral conforme cláusula 3.
5.3. Utilizar o material exclusivamente para fins decorativos, comprometendo-se a não aplicar cola, fita permanente, tinta, água ou qualquer substância que possa danificar a peça, bem como a não realizar alterações estruturais ou adaptações sem autorização.
5.4. Manter o item em perfeito estado durante o período de locação.
5.5. Devolver o material nas mesmas condições em que foi recebido.
5.6. Responsabilizar-se por qualquer dano, perda, extravio ou avaria, comprometendo-se a ressarcir integralmente o valor correspondente.

CLÁUSULA 6 - DO USO, CONSERVAÇÃO E DEVOLUÇÃO DO MATERIAL LOCADO
6.1. O CONTRATANTE declara receber o material em perfeito estado.
6.2. Eventuais avarias serão avaliadas pela CONTRATADA, que apresentará orçamento para reparo ou substituição.
6.3. Em caso de perda total ou não devolução, o LOCATÁRIO deverá ressarcir o valor integral das peças abaixo descritas:
Valor de reposição: R$ ${this.dadosFechamento.valorReposicao.toFixed(2)}

CLÁUSULA 7 - DA DESISTÊNCIA
7.1. Em caso de desistência após a confirmação da reserva, o CONTRATANTE deverá pagar 50% do valor total da locação, correspondente aos custos operacionais de higienização, adaptação, bloqueio de agenda e montagem.
7.2. Caso o valor pago seja inferior a 50%, deverá complementar até atingir esse percentual.

CLÁUSULA 8 - DA RESCISÃO
8.1. O descumprimento contratual por qualquer das partes poderá ensejar rescisão imediata, respondendo a parte inadimplente por eventuais perdas e danos.

CLÁUSULA 9 - DA BOA-FÉ E CONDUTA
9.1. As partes comprometem-se a agir com boa-fé, lealdade e cooperação, observando os princípios contratuais previstos na legislação civil.
9.2. Eventuais situações não previstas serão resolvidas de comum acordo, sempre buscando equilíbrio e razoabilidade.

CLÁUSULA 10 - DISPOSIÇÕES GERAIS
10.1. Este contrato possui força executiva entre as partes.
10.2. Fica eleito o foro da Comarca de Criciúma/SC para dirimir quaisquer controvérsias oriundas deste contrato.

E, por estarem justos e contratados, firmam o presente instrumento em duas vias de igual teor.

Criciúma/SC, ${new Date().toLocaleDateString("pt-BR")}.`;

    // Divide o texto em linhas respeitando a largura total da página
    const linhas = doc.splitTextToSize(contratoTexto, pageWidth);

    linhas.forEach((linha: string) => {
      // Ajuste de página se necessário
      if (y > 275) {
        doc.addPage();
        y = 20;
      }

      // Estilo de Título e Cláusulas
      if (linha.trim().startsWith('CLÁUSULA') || linha.trim().includes('CONTRATO DE LOCAÇÃO')) {
        doc.setFont("times", "bold");
        doc.setFontSize(11);
      } else {
        doc.setFont("times", "normal");
        doc.setFontSize(10);
      }

      // Centralizar apenas o título principal
      if (linha.includes('CONTRATO DE LOCAÇÃO')) {
        doc.text(linha.trim(), 105, y, { align: "center" });
      } else {
        doc.text(linha, margin, y);
      }

      y += 6; // Espaçamento entre linhas
    });

    // Bloco de Assinaturas (Garante que fiquem juntas no final ou em nova página)
        if (y > 220) { doc.addPage(); y = 40; } else { y += 25; }

        // Injeta a assinatura da Gê e do Cliente no PDF dinamicamente
        // A regra aciona a assinatura da Gê se for um fechamento ou se o cliente já tiver assinado
        if (!ehApenasOrcamento || this.locacaoSelecionada.assinaturaCliente) {
          const base64Ge = await this.carregarImagemBase64(this.assinaturaGeUrl);
          if (base64Ge) {
            // Posiciona a assinatura da Gê sobre a linha esquerda
            doc.addImage(base64Ge, 'PNG', margin + 10, y - 22, 50, 20);
          }
        }

        if (this.locacaoSelecionada.assinaturaCliente) {
          // Posiciona a assinatura do Cliente capturada via Canvas sobre a linha direita
          doc.addImage(this.locacaoSelecionada.assinaturaCliente, 'PNG', 130, y - 22, 50, 20);
        }

        doc.setFont("times", "bold");
        doc.line(margin, y, 90, y); // Linha da Geruza
        doc.line(120, y, 190, y); // Linha do Cliente

        y += 5;
        doc.setFontSize(9);
        doc.text("GERUZA PERUCHI DA ROSA", margin + 5, y);
        doc.text(this.locacaoSelecionada.cliente.nome.toUpperCase(), 125, y);

        y += 4;
        doc.setFont("times", "normal");
        doc.text("ARTE FESTIVA ATELIÊ", margin + 11, y);
        doc.text("CONTRATANTE", 145, y);

        doc.save(`Contrato_${nomeLimpo}.pdf`);
    }

    try {
      // Usa o getter totalGeral para garantir que a taxa de entrega entre na dívida no banco
      const total = this.totalGeral; 
      const sinal = this.dadosFechamento.valorSinal || 0;
      
      let novoStatus = '';
      let valorSinalContabilizado = 0;
      let valorPendenteContabilizado = total;

      if (ehApenasOrcamento) {
        novoStatus = 'orcamento_enviado';
        // Trava de Negócio: Em fase de orçamento, o sinal não é debitado do cliente. 
        // Ele deve continuar devendo 100% até que aprove e pague de fato via Webhook/Manual.
        valorSinalContabilizado = 0; 
        valorPendenteContabilizado = total;
      } else {
        // Fluxo de Fechamento Real Direto (Ex: Pix Manual Confirmado na hora)
        novoStatus = (sinal >= total && total > 0) ? 'pago' : 'pago_parcialmente';
        valorSinalContabilizado = sinal;
        valorPendenteContabilizado = Math.max(0, total - sinal);
      }

      // Payload atualizado para persistir a logística e a trava contábil
      const payloadFinanceiro = {
        status: novoStatus,
        valorTotalAcordado: total,
        valorSinalAcordado: sinal, // Salva a intenção de sinalização para usar na automação de pagamentos
        valorSinalPago: valorSinalContabilizado, // Só debita no saldo se o contrato for fechado
        valorPendente: valorPendenteContabilizado,
        dataRetiradaAcordada: this.dadosFechamento.dataRetirada,
        horarioRetirada: this.dadosFechamento.horarioAjustado,
        dataDevolucaoAcordada: this.dadosFechamento.dataDevolucao,
        tipoLogistica: this.dadosFechamento.tipoLogistica,
        enderecoEntrega: this.dadosFechamento.enderecoEntrega,
        valorEntrega: this.dadosFechamento.valorEntrega
      };

      await this.boloService.atualizarLocacao(this.locacaoSelecionada.id, payloadFinanceiro);
      this.fecharModalContrato();
    } catch (error) {
      console.error("Falha ao injetar dados financeiros da locação no Firestore:", error);
      alert("Erro ao atualizar o status do contrato. Verifique o console.");
    }
  }

  // ==========================================
  // LÓGICA DO MODAL DE ACERTO (PAGAMENTO PARCIAL)
  // ==========================================
  
  showModalAcerto = false;
  dadosAcerto = { valorCobrado: 0 };

  abrirModalAcerto(loc: any) {
    this.locacaoSelecionada = loc;
    this.dadosAcerto = {
      valorCobrado: loc.valorPendente || 0 // Traz o saldo devedor por padrão
    };

    history.pushState({ modal: 'acerto' }, '', window.location.href);
    this.modalAdminAbertoViaHistory = true;

    this.showModalAcerto = true;
  }

  get porcentagemDescontoAcerto(): number {
    const base = parseFloat(this.locacaoSelecionada?.valorReferencia) || 0;
    const pendenteTeorico = this.locacaoSelecionada?.valorPendente || 0;
    const cobrado = this.dadosAcerto.valorCobrado || 0;

    // Não há desconto se o valor base for zero, ou se ela estiver cobrando igual/mais que o pendente
    if (base <= 0 || cobrado >= pendenteTeorico) return 0;
    
    // O percentual é a diferença entre o que o cliente devia e o que está pagando agora, baseado no valor da peça
    const diferencaPerdoada = pendenteTeorico - cobrado;
    return (diferencaPerdoada / base) * 100;
  }

  async finalizarAcerto() {
    this.loading = true;
    try {
      await this.boloService.atualizarLocacao(this.locacaoSelecionada.id, {
        status: 'pago', // Finaliza o fluxo convertendo para pago
        valorPendente: 0,
        valorAcertoFinal: this.dadosAcerto.valorCobrado
      });
      this.fecharModalAcerto();
      alert("Acerto financeiro finalizado com sucesso. O item agora consta como pago.");
    } catch (error) {
      console.error("Erro ao registrar o acerto no Firebase:", error);
      alert("Falha ao processar o pagamento final.");
    } finally {
      this.loading = false;
    }
  }

  /**
   * Executa a baixa de auditoria manual em dinheiro vivo ou cartão direto no card da agenda
   */
  async registrarPagamentoManual(loc: any) {
    const valorAtualPendente = Number(loc.valorPendente || 0);
    
    // Prompt nativo para inserção de valores com a âncora do saldo atual
    const inputValor = prompt(
      `Saldo Devedor Atual: R$ ${valorAtualPendente.toFixed(2)}\n\nDigite o valor recebido em dinheiro ou cartão físico:`, 
      valorAtualPendente.toString()
    );

    if (inputValor === null) return; // Aborta se clicar em cancelar

    const valorPago = parseFloat(inputValor.replace(',', '.'));
    if (isNaN(valorPago) || valorPago <= 0 || valorPago > valorAtualPendente) {
      alert('⚠️ Operação abortada: O valor digitado é inválido ou excede o saldo pendente atual!');
      return;
    }

    this.loading = true;
    try {
      const novoValorPendente = Math.max(0, valorAtualPendente - valorPago);
      const statusAtual = loc.status;
      
      // Validação de estágio do caixa para manter conformidade contábil
      const ehAcertoFinal = statusAtual === 'pago_parcialmente' || statusAtual === 'contrato_assinado' || statusAtual === 'entregue';
      
      const dadosAtualizados: any = {
        valorPendente: novoValorPendente,
        valorSinalPago: Number(loc.valorSinalPago || 0) + (ehAcertoFinal ? 0 : valorPago),
        valorAcertoFinal: Number(loc.valorAcertoFinal || 0) + (ehAcertoFinal ? valorPago : 0)
      };

      // Se zerou o saldo, empurra logicamente para o status 'pago' para liberação do fluxo
      if (novoValorPendente === 0) {
        if (statusAtual === 'pago_parcialmente' || statusAtual === 'orcamento_enviado' || statusAtual === 'contrato_assinado') {
          dadosAtualizados.status = 'pago';
        }
      }

      await this.boloService.atualizarLocacao(loc.id, dadosAtualizados);
      alert(`✅ Sucesso! Recebimento de R$ ${valorPago.toFixed(2)} registrado e abatido com sucesso.`);
    } catch (error) {
      console.error('Erro ao processar baixa manual no painel:', error);
      alert('🔴 Falha técnica ao atualizar o pagamento manual. Tente novamente.');
    } finally {
      this.loading = false;
    }
  }

  responderOrcamento(ped: any) {
    // Formata a data
    const dataFormatada = new Date(ped.dataEvento).toLocaleDateString('pt-BR');

    // .trim() remove espaços extras que quebram o negrito do WhatsApp
    const nomeCliente = ped.nome.trim();
    const temaBolo = ped.tema.trim();

    const msg = `Olá *${nomeCliente}* tudo bem?%0A` +
      `Esperamos que sim.%0A%0A` +
      `Estamos retornando o seu contato sobre o pedido de locação para o tema de bolo *${temaBolo}*.%0A%0A` +
      `*Informações do pedido:*%0A` +
      `- Data: ${dataFormatada}%0A` +
      `- Configuração: ${ped.andares} andar%0A` +
      `- Observações: ${ped.observacoes.trim()}%0A%0A` +
      `Podemos dar início a essa solicitação?%0A%0A` +
      `Me chamo Gerusa e sou proprietária da *Arte Festiva Ateliê* e será um prazer te atender.`;

    const fone = ped.whatsapp.replace(/\D/g, '');
    window.open(`https://wa.me/55${fone}?text=${msg}`, '_blank');
  }

  // --- MÉTODOS DE GERENCIAMENTO GERAL ---

  async mudarStatus(id: string, novoStatus: string) {
    // Travas de segurança para evitar cliques acidentais em operações críticas de logística
    if (novoStatus === 'entregue' && !confirm("Confirmar a entrega/retirada deste item ao cliente?")) return;
    if (novoStatus === 'finalizado' && !confirm("Confirma o recebimento da devolução física desta peça? O ciclo da locação será encerrado.")) return;

    try {
      const payload: any = { status: novoStatus };
      
      // Captura a data e hora do sistema no momento exato do clique (Log de Baixa)
      const agora = new Date().toLocaleString('pt-BR');
      
      if (novoStatus === 'entregue') {
        payload.dataBaixaEntrega = agora;
      } else if (novoStatus === 'finalizado') {
        payload.dataBaixaDevolucao = agora;
      }

      await this.boloService.atualizarLocacao(id, payload);
    } catch (error) {
      console.error("Erro ao dar baixa no sistema:", error);
      alert("Erro ao mudar status.");
    }
  }

  async cancelarReservaManual(id: string) {
    if (!confirm("Atenção: Deseja realmente cancelar esta reserva manualmente? O bolo será liberado no catálogo imediatamente.")) return;
    
    this.loading = true;
    try {
      await this.boloService.atualizarLocacao(id, {
        status: 'cancelado',
        motivoCancelamento: 'Cancelado manualmente pela Gerusa no painel de administração.',
        dataCancelamento: new Date().toLocaleString('pt-BR')
      });
      alert("Reserva cancelada com sucesso! A data da peça já está livre na vitrine.");
    } catch (error) {
      console.error("Erro técnico ao abortar contrato via painel:", error);
      alert("Falha ao cancelar a reserva.");
    } finally {
      this.loading = false;
    }
  }

  async excluirOrcamento(id: string) {
    if (confirm("Deseja remover este pedido de orçamento?")) {
      await this.boloService.excluirOrcamento(id);
    }
  }

  async excluirBolo(id: string, nome: string) {
    if (confirm(`ATENÇÃO: Deseja realmente excluir o item "${nome}" do catálogo? Esta ação não pode ser desfeita e removerá a peça da vitrine imediatamente.`)) {
      this.loading = true;
      try {
        await this.boloService.excluirBolo(id);
        alert("Item excluído com sucesso!");
      } catch (error) {
        console.error("Erro ao excluir:", error);
        alert("Falha ao excluir. Verifique sua conexão.");
      } finally {
        this.loading = false;
      }
    }
  }

  onFileSelected(event: any) {
    this.fileToUpload = event.target.files[0];
  }

  async salvar() {
    this.loading = true;
    try {
      if (this.tipoCadastro === 'bolo') {
        await this.boloService.salvarBolo(this.novoBolo, this.fileToUpload);
        this.novoBolo = { codigo: '', nome: '', categoria: 'Casamento', valorLocacao: 0, descricao: '', boleirasCompativeis: [] };
      } else if (this.tipoCadastro === 'banner') {
        await this.boloService.salvarBanner(this.novoBanner, this.fileToUpload);
        this.novoBanner = { title: '', subtitle: '', imageUrl: '' };
      }
      alert("Salvo com sucesso!");
    } catch (error) {
      console.error("Falha técnica no processo de salvamento/upload:", error);
      alert("Erro ao salvar. Verifique o log no F12 para o rastreio exato.");
    } finally {
      this.loading = false;
      this.fileToUpload = null;
    }
  }

  // ==========================================
  // SESSÃO: GESTÃO DE ACERVO E GALERIA
  // ==========================================

  atualizarBusca() {
    this.termoBusca$.next(this.textoBusca);
  }

  atualizarBuscaAgenda() {
    this.termoBuscaAgenda$.next(this.textoBuscaAgenda);
  }

  filtrarPorStatus(status: string) {
    this.textoBuscaAgenda = status;
    this.atualizarBuscaAgenda();
  }
  
  async atualizarBoloCompleto(bolo: any) {
    this.loading = true;
    try {
      // Validação de escopo de unicidade para o código
      const codigoExiste = await this.boloService.verificarCodigoExistente(bolo.codigo, bolo.id);
      if (codigoExiste) {
        alert(`Operação Abortada: O código "${bolo.codigo}" já está em uso por outro bolo no sistema.`);
        this.loading = false;
        return;
      }

      // Payload blindado com todas as propriedades editáveis
      const payload = { 
        codigo: bolo.codigo, 
        nome: bolo.nome,
        categoria: bolo.categoria,
        valorLocacao: bolo.valorLocacao,
        descricao: bolo.descricao,
        boleirasCompativeis: bolo.boleirasCompativeis || []
      };

      await this.boloService.atualizarBolo(bolo.id, payload);
      alert("Cadastro atualizado com sucesso!");
    } catch (error) {
      alert("Erro ao atualizar o cadastro.");
    } finally {
      this.loading = false;
    }
  }

  // ==========================================
  // SESSÃO: MÁSCARAS E FORMATAÇÃO VANILLA
  // ==========================================
  
  // Formata o número puro do banco para o visual com vírgula no template
  formatarMoedaVisor(valor: number): string {
    if (!valor) return '';
    return valor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Intercepta a digitação, salva como float no Firebase e formata na tela
  aplicarMascaraMoeda(event: any, obj: any, campo: string, triggerCalc: boolean = false, autoAjustarSinal: boolean = false) {
    const input = event.target;
    let valorLimpo = input.value.replace(/\D/g, ''); // Arranca tudo que não for número
    const numero = valorLimpo ? parseInt(valorLimpo, 10) / 100 : 0; // Transforma em centavos/reais
    
    obj[campo] = numero; // Salva o número puro no objeto/banco
    input.value = this.formatarMoedaVisor(numero); // Devolve formatado para a tela
    
    if (triggerCalc) this.calcularValores(autoAjustarSinal);
  }

  // Máscara inteligente para HH:mm
  aplicarMascaraHora(event: any, obj: any, campo: string) {
    const input = event.target;
    let val = input.value.replace(/\D/g, '');
    if (val.length > 4) val = val.substring(0, 4);
    if (val.length > 2) val = val.substring(0, 2) + ':' + val.substring(2);
    
    obj[campo] = val;
    input.value = val;
  }

  // ==========================================
  // LÓGICA DE DRAG & DROP E ARRAY UNIFICADO
  // ==========================================

  draggedIndex: number | null = null;

  obterTodasImagens(bolo: any): string[] {
    // Constrói um array unificado visual mantendo a ordem das prioridades
    const imgs = [];
    if (bolo.imagemUrl) imgs.push(bolo.imagemUrl);
    if (bolo.imagemSecundaria) imgs.push(bolo.imagemSecundaria);
    if (bolo.galeria && bolo.galeria.length) imgs.push(...bolo.galeria);
    // Remove qualquer URL duplicada por garantia
    return [...new Set(imgs)].filter(Boolean);
  }

  onDragStart(index: number) {
    this.draggedIndex = index;
  }

  onDragOver(event: DragEvent) {
    event.preventDefault(); // Obrigatório para o drop funcionar no HTML5
  }

  async onDrop(bolo: any, dropIndex: number) {
    if (this.draggedIndex === null || this.draggedIndex === dropIndex) return;

    // Mutação de array cirúrgica
    const imagens = this.obterTodasImagens(bolo);
    const [draggedImg] = imagens.splice(this.draggedIndex, 1);
    imagens.splice(dropIndex, 0, draggedImg);

    this.draggedIndex = null;
    await this.salvarOrdemImagens(bolo, imagens);
  }

  async salvarOrdemImagens(bolo: any, imagens: string[]) {
    // Reconverte o array único para as 3 gavetas do banco de dados
    const payload = {
      imagemUrl: imagens[0] || '',
      imagemSecundaria: imagens[1] || '',
      galeria: imagens.slice(2)
    };
    try {
      await this.boloService.atualizarBolo(bolo.id, payload);
    } catch (error) {
      console.error("Erro técnico no banco ao reordenar imagens:", error);
      alert("Falha ao salvar nova ordem das imagens.");
    }
  }

  async adicionarImagemGaleria(bolo: any, event: any) {
    const file = event.target.files[0];
    if (!file) return;
    this.loading = true;
    try {
      const novaUrl = await this.boloService.uploadImagemAvulsa(file);
      const imagens = this.obterTodasImagens(bolo);
      imagens.push(novaUrl); // Nova imagem sempre vai para o fim da fila
      await this.salvarOrdemImagens(bolo, imagens);
    } catch (error) {
      console.error("Falha técnica ao fazer upload da imagem avulsa para o Storage:", error);
      alert("Erro ao subir a imagem para a galeria. Verifique o log no F12.");
    } finally {
      this.loading = false;
    }
  }

  async removerImagemGaleria(bolo: any, imgUrl: string) {
    if(!confirm("Tem certeza que deseja excluir esta foto definitivamente?")) return;
    try {
      const imagens = this.obterTodasImagens(bolo).filter((img: string) => img !== imgUrl);
      await this.salvarOrdemImagens(bolo, imagens);
    } catch (error) {
      console.error("Erro ao excluir imagem:", error);
      alert("Erro ao excluir imagem.");
    }
  }
}

