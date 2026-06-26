import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Firestore, doc, getDoc, setDoc } from '@angular/fire/firestore';

@Component({
  selector: 'app-cobranca',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './cobranca.html'
})
export class CobrancaComponent implements OnInit {
  private firestore = inject(Firestore);

  apiKey: string = '';
  loading: boolean = false;
  salvando: boolean = false;

  // URL Pública do Webhook da Cloud Function (Infraestrutura Cloud Run)
  urlWebhook: string = 'https://webhookasaas-qsk6sxgllq-uc.a.run.app';

  ngOnInit() {
    this.carregarConfiguracao();
  }

  async carregarConfiguracao() {
    this.loading = true;
    try {
      const docRef = doc(this.firestore, 'configuracoes/asaas');
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        const data = docSnap.data();
        this.apiKey = data['apiKey'] || '';
      }
    } catch (error) {
      console.error("Erro ao carregar configuração do Asaas", error);
    } finally {
      this.loading = false;
    }
  }

  async salvar() {
    if (!this.apiKey) {
      alert("A chave de API não pode estar vazia.");
      return;
    }

    this.salvando = true;
    try {
      const docRef = doc(this.firestore, 'configuracoes/asaas');
      await setDoc(docRef, {
        apiKey: this.apiKey,
        atualizadoEm: new Date().toISOString()
      }, { merge: true });
      alert('Credenciais salvas e propagadas para o servidor com sucesso!');
    } catch (error) {
      console.error("Erro ao salvar configuração do Asaas", error);
      alert('Falha ao salvar as configurações no banco.');
    } finally {
      this.salvando = false;
    }
  }

  copiarWebhook() {
    navigator.clipboard.writeText(this.urlWebhook);
    alert('URL do Webhook copiada para a área de transferência!');
  }
}