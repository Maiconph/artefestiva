import { Component, OnInit, ElementRef, ViewChild, inject, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Firestore, doc, getDoc, updateDoc } from '@angular/fire/firestore';

@Component({
  selector: 'app-assinatura',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './assinatura.html'
})
export class AssinaturaUI implements OnInit {
  private firestore = inject(Firestore);
  private route = inject(ActivatedRoute);

  @ViewChild('canvasElement', { static: false }) canvasRef!: ElementRef<HTMLCanvasElement>;
  private ctx!: CanvasRenderingContext2D;

  locacaoId: string | null = null;
  locacao: any = null;
  
  carregando = true;
  salvando = false;
  aceitouTermos = false;
  assinaturaVazia = true;
  
  // Controle de Overlay Tela Cheia
  modoAssinaturaAtivo = false;

  private desenhando = false;

  ngOnInit() {
    this.locacaoId = this.route.snapshot.paramMap.get('id');
    if (this.locacaoId) {
      this.carregarDadosLocacao(this.locacaoId);
    } else {
      this.carregando = false;
    }
  }

  // ngAfterViewInit removido para blindar contra Race Condition. O canvas será chamado após o banco de dados.

  // ==========================================
  // SESSÃO: COMUNICAÇÃO DE DADOS V9 MODULAR
  // ==========================================

  async carregarDadosLocacao(id: string) {
    try {
      const docRef = doc(this.firestore, `locacoes/${id}`);
      const docSnap = await getDoc(docRef);
      
      if (docSnap.exists()) {
        this.locacao = { id: docSnap.id, ...docSnap.data() };
      }
    } catch (error) {
      console.error('Erro ao buscar locação:', error);
    } finally {
      this.carregando = false;
      // O canvas só será montado em memória quando o usuário engatilhar a tela cheia
    }
  }

  async abrirModoAssinatura() {
    if (!this.aceitouTermos) return;
    this.modoAssinaturaAtivo = true;

    // Engatilha a Fullscreen API e trava a orientação via Motor Chromium/Webkit
    try {
      const docEl = document.documentElement;
      if (docEl.requestFullscreen) {
        await docEl.requestFullscreen();
      }
      if (screen.orientation && 'lock' in screen.orientation) {
        await (screen.orientation as any).lock('landscape');
      }
    } catch (err) {
      console.warn("Dispositivo com restrição nativa de orientação. Fallback visual ativado.", err);
    }

    // Delay tático para o DOM esticar antes de calcular a largura do canvas
    setTimeout(() => this.inicializarCanvas(), 200);
  }

  async concluirEAssinar() {
    if (this.assinaturaVazia) return;

    // Destroi o modo tela cheia e destrava o giroscópio
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      }
      if (screen.orientation && 'unlock' in screen.orientation) {
        screen.orientation.unlock();
      }
    } catch(e) {}

    this.modoAssinaturaAtivo = false;
    await this.confirmarAssinatura(); // Despacha para o banco
  }

  async confirmarAssinatura() {
    if (!this.locacaoId || this.assinaturaVazia || !this.aceitouTermos) return;

    this.salvando = true;
    try {
      // Captura o desenho do canvas em formato Base64 nativo
      const base64Assinatura = this.canvasRef.nativeElement.toDataURL('image/png');

      const docRef = doc(this.firestore, `locacoes/${this.locacaoId}`);
      await updateDoc(docRef, {
        assinaturaCliente: base64Assinatura,
        status: 'contrato_assinado',
        dataAssinatura: new Date().toISOString()
      });

      this.locacao.status = 'contrato_assinado';
    } catch (error) {
      console.error('Falha técnica ao injetar assinatura no banco:', error);
      alert('Erro ao salvar assinatura. Tente novamente.');
    } finally {
      this.salvando = false;
    }
  }

  // ==========================================
  // SESSÃO: MOTOR DE DESENHO (MOUSE & TOUCH)
  // ==========================================

  inicializarCanvas() {
    if (!this.canvasRef) return;
    const canvas = this.canvasRef.nativeElement;
    
    // Assunção de Tela Cheia Real
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    this.ctx = canvas.getContext('2d')!;
    this.ctx.lineWidth = 3;
    this.ctx.lineCap = 'round';
    this.ctx.strokeStyle = '#0f172a'; // Caneta escura (azul marinho/preto) para contraste no PDF
  }

  iniciarDesenho(event: MouseEvent | TouchEvent) {
    event.preventDefault(); // Trava o scroll da tela
    this.desenhando = true;
    this.assinaturaVazia = false;
    const pos = this.obterPosicao(event);
    this.ctx.beginPath();
    this.ctx.moveTo(pos.x, pos.y);
  }

  desenhar(event: MouseEvent | TouchEvent) {
    event.preventDefault();
    if (!this.desenhando) return;
    const pos = this.obterPosicao(event);
    this.ctx.lineTo(pos.x, pos.y);
    this.ctx.stroke();
  }

  pararDesenho() {
    this.desenhando = false;
    this.ctx.closePath();
  }

  limparCanvas() {
    const canvas = this.canvasRef.nativeElement;
    this.ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.assinaturaVazia = true;
  }

  private obterPosicao(event: MouseEvent | TouchEvent) {
    const canvas = this.canvasRef.nativeElement;
    const rect = canvas.getBoundingClientRect();
    let clientX, clientY;

    if (event instanceof TouchEvent) {
      clientX = event.touches[0].clientX;
      clientY = event.touches[0].clientY;
    } else {
      clientX = event.clientX;
      clientY = event.clientY;
    }

    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  }
}