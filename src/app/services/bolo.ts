import { inject, Injectable } from '@angular/core';
import {
  Firestore,
  collection,
  collectionData,
  addDoc,
  doc,
  docData,
  query,
  where,
  getDocs,
  getDoc,
  updateDoc,
  orderBy,
  deleteDoc
} from '@angular/fire/firestore';
import {
  Storage,
  ref,
  uploadBytes,
  getDownloadURL
} from '@angular/fire/storage';
import { Observable } from 'rxjs';

export interface Bolo {
  id?: string;
  nome: string;
  categoria: string | string[]; // Suporte híbrido (legado em string e novo modelo em array)
  valorLocacao: number;
  descricao: string;
  imagemUrl: string;
}

export interface Banner {
  id?: string;
  title: string;
  subtitle: string;
  imageUrl: string;
}

export interface Boleira {
  id?: string;
  nome: string;
  tamanho: string;
  cor: string;
  valorLocacao: number;
  imagemUrl: string;
}

@Injectable({
  providedIn: 'root'
})
export class BoloService {
  private firestore = inject(Firestore);
  private storage = inject(Storage);

  // --- MÉTODOS DE BOLOS ---
  getBolos(): Observable<Bolo[]> {
    const bolosRef = collection(this.firestore, 'bolos');
    return collectionData(bolosRef, { idField: 'id' }) as Observable<Bolo[]>;
  }

  getBoloById(id: string): Observable<Bolo> {
    const boloDocRef = doc(this.firestore, `bolos/${id}`);
    return docData(boloDocRef, { idField: 'id' }) as Observable<Bolo>;
  }

  // Renomeado para bater com o admin.ts
  async salvarBolo(bolo: any, imagem: File | null) {
    let url = bolo.imagemUrl || '';

    if (imagem) {
      url = await this.uploadImagem(imagem, 'bolos');
    }

    const bolosRef = collection(this.firestore, 'bolos');
    return addDoc(bolosRef, { ...bolo, imagemUrl: url });
  }

  // Exclui o bolo do banco de dados definitivamente
  async excluirBolo(id: string) {
    const boloDocRef = doc(this.firestore, `bolos/${id}`);
    return deleteDoc(boloDocRef);
  }

  // Atualiza propriedades parciais do documento usando Firebase V9 Modular
  async atualizarBolo(id: string, payload: any) {
    const boloDocRef = doc(this.firestore, `bolos/${id}`);
    return updateDoc(boloDocRef, payload);
  }

  // Verifica unicidade do código (ignora o próprio ID atual na checagem)
  async verificarCodigoExistente(codigo: string, idAtual: string = ''): Promise<boolean> {
    if (!codigo) return false;
    const bolosRef = collection(this.firestore, 'bolos');
    const q = query(bolosRef, where('codigo', '==', codigo));
    const snap = await getDocs(q);
    // Retorna true se encontrou o código em UM documento que NÃO seja o atual
    return snap.docs.some(doc => doc.id !== idAtual);
  }

  // Delega o arquivo para a função privada apontando para a pasta correta
  async uploadImagemAvulsa(file: File): Promise<string> {
    return this.uploadImagem(file, 'galeria_bolos');
  }

  // --- MÉTODOS DE BOLEIRAS (SUPORTES) ---
  getBoleiras(): Observable<Boleira[]> {
    const suportesRef = collection(this.firestore, 'suportes');
    return collectionData(suportesRef, { idField: 'id' }) as Observable<Boleira[]>;
  }

  async salvarBoleira(boleira: any, imagem: File | null) {
    let url = boleira.imagemUrl || '';

    if (imagem) {
      url = await this.uploadImagem(imagem, 'suportes');
    }

    const suportesRef = collection(this.firestore, 'suportes');
    return addDoc(suportesRef, { ...boleira, imagemUrl: url });
  }

  async atualizarBoleira(id: string, payload: any) {
    const suporteDocRef = doc(this.firestore, `suportes/${id}`);
    return updateDoc(suporteDocRef, payload);
  }

  async excluirBoleira(id: string) {
    const suporteDocRef = doc(this.firestore, `suportes/${id}`);
    return deleteDoc(suporteDocRef);
  }

  // --- MÉTODOS DE BANNERS ---
  getBanners(): Observable<Banner[]> {
    const bannersRef = collection(this.firestore, 'banners');
    return collectionData(bannersRef, { idField: 'id' }) as Observable<Banner[]>;
  }

  // Renomeado para bater com o admin.ts
  async salvarBanner(banner: any, imagem: File | null) {
    let url = '';

    if (imagem) {
      url = await this.uploadImagem(imagem, 'banners');
    }

    const bannersRef = collection(this.firestore, 'banners');
    return addDoc(bannersRef, { ...banner, imageUrl: url });
  }

  // --- MÉTODOS DA AGENDA (LOCAÇÕES) ---
  getLocacoes(): Observable<any[]> {
    const locacoesRef = collection(this.firestore, 'locacoes');
    const q = query(locacoesRef, orderBy('dataEvento', 'asc'));
    return collectionData(q, { idField: 'id' });
  }

  async verificarDisponibilidade(boloId: string, dataDesejada: string): Promise<boolean> {
    const locacoesRef = collection(this.firestore, 'locacoes');
    
    // Puxamos todas as locações do sistema para a memória.
    // (Como é um ateliê físico, o volume de contratos não vai travar o navegador e nos permite fazer cruzamentos complexos).
    const snap = await getDocs(locacoesRef);

    // O 'T00:00:00' garante que a matemática não erre o dia por causa do Fuso Horário do Brasil
    const dataDesejadaObj = new Date(dataDesejada + 'T00:00:00'); 

    const temConflito = snap.docs.some(doc => {
      const loc = doc.data();

      // 1. Ignora contratos cancelados
      if (loc['status'] === 'cancelado') return false;

      // 2. O Bolo que a Cliente Y quer está preso neste contrato da Cliente X?
      // (Verifica se ele é a peça principal OU se está dentro de um "Combo Multi-Bolo")
      const ehPecaPrincipal = loc['idBolo'] === boloId;
      const estaNoCombo = loc['bolos'] && loc['bolos'].some((b: any) => b.id === boloId);

      if (!ehPecaPrincipal && !estaNoCombo) return false; // Bolo não está aqui, passa pro próximo contrato.

      // 3. Calcula os muros de tempo (Quando o bolo sai e quando ele volta)
      const dataInicioStr = loc['dataRetiradaAcordada'] || loc['dataEvento'];
      const dataFimStr = loc['dataDevolucaoAcordada'] || loc['dataEvento'];

      if (!dataInicioStr || !dataFimStr) return false;

      const dataInicioObj = new Date(dataInicioStr + 'T00:00:00');
      const dataFimObj = new Date(dataFimStr + 'T00:00:00');

      // 4. A MÁGICA DE ESTOQUE: A data que a Cliente Y quer cai DENTRO do período em que o bolo está fora?
      // Se a data desejada for maior/igual à retirada E menor/igual à devolução, tem conflito!
      return dataDesejadaObj >= dataInicioObj && dataDesejadaObj <= dataFimObj;
    });

    // Se TEM conflito, o bolo NÃO ESTÁ disponível (false)
    return !temConflito;
  }

  async salvarLocacao(dados: any) {
    const locacoesRef = collection(this.firestore, 'locacoes');
    return addDoc(locacoesRef, {
      ...dados,
      status: 'aguardando_orcamento',
      dataCriacao: new Date()
    });
  }

  async atualizarStatusLocacao(id: string, novoStatus: string) {
    const docRef = doc(this.firestore, `locacoes/${id}`);
    return updateDoc(docRef, { status: novoStatus });
  }

  // Atualiza dados financeiros completos e status de uma locação (Motor Inteligente)
  async atualizarLocacao(id: string, payload: any) {
    const docRef = doc(this.firestore, `locacoes/${id}`);
    return updateDoc(docRef, payload);
  }

  // Busca cirúrgica de reserva via ID único ou Código 6 dígitos (Para o front-end Minhas Reservas)
  async buscarReservaPorCodigo(codigo: string): Promise<any | null> {
    try {
      const locacoesRef = collection(this.firestore, 'locacoes');
      
      // 1. Busca pela query do código de 6 dígitos gerado pelo sistema
      const q = query(locacoesRef, where('codigoReserva', '==', codigo));
      const snap = await getDocs(q);

      if (!snap.empty) {
        const docSnap = snap.docs[0];
        return { id: docSnap.id, ...docSnap.data() };
      }

      // 2. Fallback de Segurança: Tenta ver se a cliente colou o ID gigante do Firebase por engano
      const docRef = doc(this.firestore, `locacoes/${codigo}`);
      const docSnapFallback = await getDoc(docRef);
      if (docSnapFallback.exists()) {
        return { id: docSnapFallback.id, ...docSnapFallback.data() };
      }

      return null;
    } catch (error) {
      console.error("Falha técnica ao consultar a reserva no Firestore:", error);
      return null;
    }
  }

  // --- MÉTODOS DE ORÇAMENTOS ---
  async salvarOrcamento(dados: any) {
    const orcamentosRef = collection(this.firestore, 'orcamentos');
    return addDoc(orcamentosRef, {
      ...dados,
      status: 'novo',
      dataCriacao: new Date()
    });
  }

  getOrcamentos(): Observable<any[]> {
    const orcamentosRef = collection(this.firestore, 'orcamentos');
    const q = query(orcamentosRef, orderBy('dataCriacao', 'desc'));
    return collectionData(q, { idField: 'id' });
  }

  // Renomeado para excluirOrcamento
  async excluirOrcamento(id: string) {
    const docRef = doc(this.firestore, `orcamentos/${id}`);
    return deleteDoc(docRef);
  }

  // --- MÉTODOS DE PARCEIROS (MENSALISTAS) ---
  getMensalistas(): Observable<any[]> {
    const mensalistasRef = collection(this.firestore, 'mensalistas');
    // Lê os dados em tempo real
    return collectionData(mensalistasRef, { idField: 'id' });
  }

  // Função cirúrgica que puxa as locações específicas deste parceiro no banco
  async getFaturasParceiro(nomeParceiro: string): Promise<any[]> {
    const locacoesRef = collection(this.firestore, 'locacoes');
    const q = query(locacoesRef, where('tipoReserva', '==', 'parceiro_mensalista'));
    const snap = await getDocs(q);
    
    return snap.docs
      .map(doc => ({ id: doc.id, ...doc.data() as any }))
      // Filtra apenas contratos não cancelados que ainda possuem saldo devedor
      .filter(loc => loc.cliente?.nome === nomeParceiro && loc.valorPendente > 0 && loc.status !== 'cancelado');
  }

  async salvarMensalista(dados: any) {
    const mensalistasRef = collection(this.firestore, 'mensalistas');
    return addDoc(mensalistasRef, {
      ...dados,
      saldoDevedor: 0, // Inicia zerado por padrão
      dataCriacao: new Date().toISOString()
    });
  }

  async atualizarMensalista(id: string, payload: any) {
    const docRef = doc(this.firestore, `mensalistas/${id}`);
    return updateDoc(docRef, payload);
  }

  async excluirMensalista(id: string) {
    const docRef = doc(this.firestore, `mensalistas/${id}`);
    return deleteDoc(docRef);
  }

  // --- FUNÇÃO PRIVADA PARA UPLOAD ---
  private async uploadImagem(file: File, pasta: string): Promise<string> {
    const path = `${pasta}/${Date.now()}_${file.name}`;
    const storageRef = ref(this.storage, path);
    const task = await uploadBytes(storageRef, file);
    return getDownloadURL(task.ref);
  }
}
