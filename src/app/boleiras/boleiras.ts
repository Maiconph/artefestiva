import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { BoloService, Boleira } from '../services/bolo';
import { Observable } from 'rxjs';

@Component({
  selector: 'app-boleiras',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './boleiras.html'
})
export class Boleiras implements OnInit {
  private boloService = inject(BoloService);
  
  loading = false;
  fileToUpload: File | null = null;
  
  novaBoleira: any = { nome: '', tamanho: '', cor: '', valorLocacao: 0, imagemUrl: '' };
  boleiras$!: Observable<Boleira[]>;

  ngOnInit() {
    this.boleiras$ = this.boloService.getBoleiras();
  }

  onFileSelected(event: any) {
    this.fileToUpload = event.target.files[0];
  }

  async salvar() {
    if (!this.novaBoleira.nome) {
      alert('Preencha pelo menos o nome do suporte.');
      return;
    }

    this.loading = true;
    try {
      await this.boloService.salvarBoleira(this.novaBoleira, this.fileToUpload);
      alert('Suporte cadastrado com sucesso!');
      this.novaBoleira = { nome: '', tamanho: '', cor: '', valorLocacao: 0, imagemUrl: '' };
      this.fileToUpload = null;
    } catch (error) {
      console.error("Erro ao salvar:", error);
      alert('Falha ao salvar no banco de dados.');
    } finally {
      this.loading = false;
    }
  }

  async atualizar(boleira: Boleira) {
    this.loading = true;
    try {
      const payload = { 
        nome: boleira.nome, 
        tamanho: boleira.tamanho, 
        cor: boleira.cor, 
        valorLocacao: boleira.valorLocacao 
      };
      await this.boloService.atualizarBoleira(boleira.id!, payload);
      alert("Suporte atualizado com sucesso!");
    } catch (error) {
      alert("Erro ao atualizar o suporte.");
    } finally {
      this.loading = false;
    }
  }

  async excluir(id: string, nome: string) {
    if (confirm(`ATENÇÃO: Deseja realmente excluir o suporte "${nome}"?`)) {
      this.loading = true;
      try {
        await this.boloService.excluirBoleira(id);
        alert("Suporte excluído com sucesso!");
      } catch (error) {
        alert("Falha ao excluir o suporte.");
      } finally {
        this.loading = false;
      }
    }
  }
}