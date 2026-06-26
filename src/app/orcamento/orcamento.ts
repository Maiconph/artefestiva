import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule, Router } from '@angular/router';
import { BoloService } from '../services/bolo';

@Component({
  selector: 'app-orcamento',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './orcamento.html',
  styleUrl: '../app.css'
})
export class OrcamentoComponent {
  private boloService = inject(BoloService);
  private router = inject(Router);

  loading = false;
  enviado = false;

  // Modelo do Pedido de Orçamento
  pedido = {
    nome: '',
    whatsapp: '',
    dataEvento: '',
    tema: '',
    andares: '1',
    observacoes: ''
  };

  async enviarOrcamento() {
    if (!this.pedido.nome || !this.pedido.whatsapp || !this.pedido.dataEvento) {
      alert("Por favor, preencha os campos obrigatórios (Nome, WhatsApp e Data).");
      return;
    }

    this.loading = true;
    try {
      await this.boloService.salvarOrcamento(this.pedido);
      this.enviado = true;

      // Opcional: Criar link para o WhatsApp já com os dados
      // this.notificarSograPorWhatsApp();

    } catch (error) {
      console.error(error);
      alert("Erro ao enviar pedido. Tente novamente.");
    } finally {
      this.loading = false;
    }
  }

  voltar() {
    this.router.navigate(['/']);
  }
}
