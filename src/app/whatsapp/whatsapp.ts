import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Firestore, doc, getDoc, setDoc } from '@angular/fire/firestore';

@Component({
  selector: 'app-whatsapp',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './whatsapp.html'
})
export class WhatsappConfig implements OnInit {
  private firestore = inject(Firestore);

  // Escopo Centralizado de Dados
  config = {
    urlApi: '',
    apiKey: '',
    numeroNotificacaoPagamento: '',
    numeroNotificacaoPagamento2: '',
    numeroNotificacaoAssinatura: '',
    numeroNotificacaoAssinatura2: '',
    numeroEntregador: ''
  };

  // Estados da Interface
  statusConexao: 'DISCONNECTED' | 'INITIALIZING' | 'CONNECTED' = 'DISCONNECTED';
  qrCodeBase64 = '';
  gerandoQrCode = false;
  ocultarApiKey = true;
  loading = false;
  
  // Constante de Infraestrutura
  instanciaNome = 'arte_festiva';
  private pollingInterval: any;

  ngOnInit() {
    this.carregarConfiguracoes();
  }

  // --- PERSISTÊNCIA NO FIREBASE V9 ---

  async carregarConfiguracoes() {
    try {
      const docRef = doc(this.firestore, 'configuracoes/whatsapp');
      const snap = await getDoc(docRef);
      if (snap.exists()) {
        this.config = snap.data() as any;
        
        // Se já tiver as credenciais salvas, bate na API para ver se o Whats está logado
        if (this.config.urlApi && this.config.apiKey) {
          await this.verificarStatusInstancia();
        }
      }
    } catch (error) {
      console.error('Erro ao carregar credenciais do WhatsApp', error);
    }
  }

  async salvarConfiguracoes() {
    this.loading = true;
    try {
      const docRef = doc(this.firestore, 'configuracoes/whatsapp');
      await setDoc(docRef, this.config, { merge: true });
      
      alert('Parâmetros gravados com sucesso!');
      if (this.config.urlApi && this.config.apiKey) {
        await this.verificarStatusInstancia();
      }
    } catch (error) {
      console.error('Falha ao salvar no Firestore', error);
      alert('Erro de banco de dados ao salvar configurações.');
    } finally {
      this.loading = false;
    }
  }

  // --- MOTOR DA EVOLUTION API ---

  async verificarStatusInstancia() {
    if (!this.config.urlApi || !this.config.apiKey) return;
    
    try {
      // Motor de Auto-Cura: Usamos a rota /connect em vez de /connectionState.
      // Assim, se o QR Code expirar (o WhatsApp gira a chave a cada 20s), 
      // nós capturamos o novo QR Code automaticamente no background sem a tela piscar.
      const res = await fetch(`${this.config.urlApi}/instance/connect/${this.instanciaNome}`, {
        method: 'GET',
        headers: { 'apikey': this.config.apiKey }
      });
      
      if (res.ok) {
        const data = await res.json();
        const state = data?.instance?.state || data?.state;
        
        if (state === 'open') {
          this.statusConexao = 'CONNECTED';
          this.qrCodeBase64 = '';
        } else if (state === 'connecting') {
           // Blindagem para diferentes versões da Evolution (data.base64 ou data.qrcode.base64)
           const novoQrCode = data?.base64 || data?.qrcode?.base64;
           if (novoQrCode) {
             this.qrCodeBase64 = novoQrCode;
             this.statusConexao = 'DISCONNECTED'; // Força a tela a manter o QR Code visível
           } else if (!this.qrCodeBase64) {
             this.statusConexao = 'INITIALIZING';
           }
        } else {
          this.statusConexao = 'DISCONNECTED';
        }
      } else {
         this.statusConexao = 'DISCONNECTED';
      }
    } catch (error) {
      console.error('Falha de rede ao consultar Evolution', error);
      this.statusConexao = 'DISCONNECTED';
    }
  }

  async gerarConexaoInstancia() {
    if (!this.config.urlApi || !this.config.apiKey) {
      alert('Ops! Salve a URL e a API Key no painel antes de gerar o QR Code.');
      return;
    }

    this.gerandoQrCode = true;
    this.statusConexao = 'INITIALIZING';
    
    try {
      // 1. Garante que a instância existe
      await fetch(`${this.config.urlApi}/instance/create`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'apikey': this.config.apiKey 
        },
        body: JSON.stringify({
          instanceName: this.instanciaNome,
          qrcode: true,
          integration: "WHATSAPP-BAILEYS"
        })
      });

      // 2. Conecta para resgatar o Buffer do QR Code (Base64)
      const res = await fetch(`${this.config.urlApi}/instance/connect/${this.instanciaNome}`, {
        method: 'GET',
        headers: { 'apikey': this.config.apiKey }
      });

      if (res.ok) {
        const data = await res.json();
        const qrcodeBase64 = data?.base64 || data?.qrcode?.base64;
        
        if (qrcodeBase64) {
           this.qrCodeBase64 = qrcodeBase64;
           this.statusConexao = 'DISCONNECTED';
           this.iniciarPollingDeStatus(); // Começa a observar a leitura
        } else if (data?.instance?.state === 'open') {
           this.statusConexao = 'CONNECTED';
           this.qrCodeBase64 = '';
        } else {
           // Fallback: Se a API demorar 1 ou 2 segundos a mais para cuspir o buffer,
           // disparamos o espião para buscar assim que estiver pronto.
           this.iniciarPollingDeStatus();
        }
      } else {
         alert('A Evolution API recusou a conexão. Verifique suas credenciais.');
         this.statusConexao = 'DISCONNECTED';
      }
    } catch (error) {
      console.error('Crash ao gerar QR Code', error);
      alert('Falha de comunicação com o servidor da Evolution.');
      this.statusConexao = 'DISCONNECTED';
    } finally {
      this.gerandoQrCode = false;
    }
  }

  async desconectarOuLimparInstancia() {
     if (!confirm('ATENÇÃO: Deseja desconectar este número? A emissão de contratos e recibos irá parar imediatamente.')) return;
     
     this.loading = true;
     try {
       await fetch(`${this.config.urlApi}/instance/logout/${this.instanciaNome}`, {
         method: 'DELETE',
         headers: { 'apikey': this.config.apiKey }
       });
       
       this.statusConexao = 'DISCONNECTED';
       this.qrCodeBase64 = '';
       if (this.pollingInterval) clearInterval(this.pollingInterval);
     } catch (error) {
       console.error('Falha ao deslogar da Evolution', error);
       alert('Erro ao tentar forçar o logout da instância.');
     } finally {
       this.loading = false;
     }
  }

  // Observador de Estado Contínuo
  iniciarPollingDeStatus() {
    if (this.pollingInterval) clearInterval(this.pollingInterval);
    
    // Bate na API a cada 4 segundos para ver se a Gê apontou a câmera pro painel
    this.pollingInterval = setInterval(async () => {
      if (this.statusConexao === 'CONNECTED') {
         clearInterval(this.pollingInterval);
         return;
      }
      await this.verificarStatusInstancia();
    }, 4000);
  }
}