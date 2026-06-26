import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { BoloService } from '../services/bolo';
import { Observable, combineLatest, BehaviorSubject } from 'rxjs';
import { map } from 'rxjs/operators';

export type TipoFiltroPeriodo = 'hoje' | 'ontem' | '7dias' | 'esteMes' | 'personalizado';

@Component({
  selector: 'app-financeiro',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './financeiro.html'
})
export class FinanceiroComponent implements OnInit {
  private boloService = inject(BoloService);

  // Estados dos Filtros Reativos
  filtroPeriodo$ = new BehaviorSubject<TipoFiltroPeriodo>('7dias');
  dataInicio$ = new BehaviorSubject<string>('');
  dataFim$ = new BehaviorSubject<string>('');

  // Inputs temporários para o HTML
  filtroSelecionado: TipoFiltroPeriodo = '7dias';
  dataInicioInput: string = '';
  dataFimInput: string = '';

  // Streams de Dados Consolidados para a UI
  resumoFinanceiro$: Observable<any> | null = null;
  listagemFiltrada$: Observable<any[]> | null = null;

  ngOnInit() {
    const locacoes$ = this.boloService.getLocacoes();
    const mensalistas$ = this.boloService.getMensalistas();

    // Pipeline unificado que processa as métricas financeiras em tempo real
    this.resumoFinanceiro$ = combineLatest([
      locacoes$,
      mensalistas$,
      this.filtroPeriodo$,
      this.dataInicio$,
      this.dataFim$
    ]).pipe(
      map(([locacoes, mensalistas, periodo, dataInicio, dataFim]) => {
        
        // 1. Filtragem Cronológica Agressiva
        const contratosFiltrados = locacoes.filter(loc => {
          if (loc.status === 'cancelado' || loc.status === 'aguardando_orcamento') return false;
          
          // Tratamento seguro de data de criação do contrato
          let dataContrato: Date;
          if (loc.dataCriacao && typeof loc.dataCriacao.toDate === 'function') {
            dataContrato = loc.dataCriacao.toDate();
          } else if (loc.dataCriacao) {
            dataContrato = new Date(loc.dataCriacao);
          } else {
            dataContrato = new Date(loc.dataEvento + 'T00:00:00');
          }

          const hoje = new Date();
          hoje.setHours(0,0,0,0);
          
          const dataAlvo = new Date(dataContrato);
          dataAlvo.setHours(0,0,0,0);

          switch (periodo) {
            case 'hoje':
              return dataAlvo.getTime() === hoje.getTime();
            case 'ontem':
              const ontem = new Date();
              ontem.setDate(hoje.getDate() - 1);
              ontem.setHours(0,0,0,0);
              return dataAlvo.getTime() === ontem.getTime();
            case '7dias':
              const seteDiasAtras = new Date();
              seteDiasAtras.setDate(hoje.getDate() - 7);
              seteDiasAtras.setHours(0,0,0,0);
              return dataAlvo >= seteDiasAtras && dataAlvo <= hoje;
            case 'esteMes':
              const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
              inicioMes.setHours(0,0,0,0);
              return dataAlvo >= inicioMes && dataAlvo <= hoje;
            case 'personalizado':
              if (!dataInicio || !dataFim) return true;
              const dInicio = new Date(dataInicio + 'T00:00:00');
              const dFim = new Date(dataFim + 'T23:59:59');
              return dataContrato >= dInicio && dataContrato <= dFim;
            default:
              return true;
          }
        });

        // 2. Consolidação de Métricas Gerais
        let faturamentoBruto = 0; // Total que o ateliê movimentou em contratos fechados
        let faturamentoLiquido = 0; // O que de fato já entrou no caixa físico/banco
        let totalAReceber = 0; // Dinheiro voando na rua (inadimplência estrutural ou acerto na entrega)

        const quitados: any[] = [];
        const garantidosSinal: any[] = [];

        contratosFiltrados.forEach(loc => {
          const bruto = parseFloat(loc.valorTotalAcordado || loc.valorReferencia || 0);
          const pendente = parseFloat(loc.valorPendente || 0);
          const pago = bruto - pendente;

          faturamentoBruto += bruto;
          faturamentoLiquido += pago;
          totalAReceber += pendente;

          const itemCard = {
            codigo: loc.codigoReserva || 'MÚLTIPLOS',
            cliente: loc.cliente?.nome || 'Cliente Particular',
            peca: loc.nomeBolo || 'Itens Locados',
            valorTotal: bruto,
            valorPendente: pendente,
            valorPago: pago,
            data: loc.dataEvento ? loc.dataEvento.split('-').reverse().join('/') : 'N/A'
          };

          // Separação de canais de cards solicitados
          if (pendente === 0 || loc.status === 'pago') {
            quitados.push(itemCard);
          } else {
            garantidosSinal.push(itemCard);
          }
        });

        // 3. Consolidação Financeira do Canal de Mensalistas
        let mensalistasPendentes = 0;
        let mensalistasPagos = 0;

        mensalistas.forEach(m => {
          mensalistasPendentes += parseFloat(m.saldoDevedor || 0);
        });

        // Varre a coleção central capturando o que os mensalistas já liquidaram no histórico global
        locacoes.forEach(loc => {
          if (loc.tipoReserva === 'parceiro_mensalista' && loc.status === 'pago') {
            mensalistasPagos += parseFloat(loc.valorAcertoFinal || loc.valorTotalAcordado || 0);
          }
        });

        return {
          faturamentoBruto,
          faturamentoLiquido,
          totalAReceber,
          mensalistasPendentes,
          mensalistasPagos,
          quitados,
          garantidosSinal
        };
      })
    );
  }

  // Despachantes de Eventos de Filtro
  alterarPeriodo(tipo: TipoFiltroPeriodo) {
    this.filtroSelecionado = tipo;
    this.filtroPeriodo$.next(tipo);
  }

  aplicarFiltroPersonalizado() {
    if (this.dataInicioInput && this.dataFimInput) {
      this.dataInicio$.next(this.dataInicioInput);
      this.dataFim$.next(this.dataFimInput);
      this.filtroPeriodo$.next('personalizado');
    }
  }
}