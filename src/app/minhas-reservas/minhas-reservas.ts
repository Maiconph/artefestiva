import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { BoloService } from '../services/bolo';

@Component({
  selector: 'app-minhas-reservas',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './minhas-reservas.html',
  styleUrl: '../app.css'
})
export class MinhasReservasClass {
  private boloService = inject(BoloService);

  codigoBusca: string = '';
  reservaEncontrada: any = null;
  buscando: boolean = false;
  erroBusca: boolean = false;

  async buscarReserva() {
    if (!this.codigoBusca.trim()) return;
    
    this.buscando = true;
    this.erroBusca = false;
    this.reservaEncontrada = null;

    try {
      // Limpa espaços acidentais e força maiúsculo para bater perfeitamente com o banco
      const codigoLimpo = this.codigoBusca.trim().toUpperCase();
      const resultado = await this.boloService.buscarReservaPorCodigo(codigoLimpo);
      
      if (resultado) {
        this.reservaEncontrada = resultado;
      } else {
        this.erroBusca = true;
      }
    } catch (error) {
      console.error("Erro na consulta de reserva:", error);
      this.erroBusca = true;
    } finally {
      this.buscando = false;
    }
  }

  chamarSuporteWhatsApp() {
    const telefoneLoja = '554835126330'; // Telefone padrão do rodapé
    const mensagem = encodeURIComponent(`Preciso de mais algumas informações sobre a minha reserva (Cód: ${this.reservaEncontrada?.codigoReserva || 'N/A'}), poderia me ajudar?`);
    window.open(`https://wa.me/${telefoneLoja}?text=${mensagem}`, '_blank');
  }
}