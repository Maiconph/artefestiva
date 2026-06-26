import { Component, inject, OnInit, OnDestroy, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { BoloService, Bolo, Banner } from '../services/bolo';
import { Observable, map, Subscription, interval } from 'rxjs';

interface Categoria {
  nome: string;
  image: string;
}

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './home.html',
  styleUrl: '../app.css'
})
export class HomeComponent implements OnInit, OnDestroy {
  private boloService = inject(BoloService);
  private router = inject(Router);

  bolosExibidos$!: Observable<Bolo[]>;
  banners$!: Observable<Banner[]>;
  suportes$!: Observable<any[]>;
  categoriaAtiva: string = 'Todos';
  suporteEmDestaque: any = null;

  // Lista de categorias com fotos específicas
  // Dica: Depois você pode trocar esses links pelas fotos reais do Firebase
  listaCategorias: Categoria[] = [
    { nome: 'Casamento', image: 'https://firebasestorage.googleapis.com/v0/b/arte-festiva-atelie.firebasestorage.app/o/iconecasamento.png?alt=media&token=8deb4b7c-a704-4f99-a3f3-b45bda465e6a' },
    { nome: 'Infantil', image: 'https://firebasestorage.googleapis.com/v0/b/arte-festiva-atelie.firebasestorage.app/o/iconeinfantil.png?alt=media&token=8f1e94ea-34dc-4ff9-a6ce-f2f20d7ffb0c' },
    { nome: '15 Anos', image: 'https://firebasestorage.googleapis.com/v0/b/arte-festiva-atelie.firebasestorage.app/o/icone15anos.png?alt=media&token=fec83f2a-66db-437e-8cd8-0967d4945880' },
    { nome: 'Batizado', image: 'https://firebasestorage.googleapis.com/v0/b/arte-festiva-atelie.firebasestorage.app/o/iconebatismo.png?alt=media&token=0a46d698-ec6f-435c-8bfa-ea118d6b22e4' },
    { nome: 'Noivado', image: 'https://firebasestorage.googleapis.com/v0/b/arte-festiva-atelie.firebasestorage.app/o/iconenoivado.png?alt=media&token=96d70662-cb38-4df7-b3a5-99fbe31ca447' },
    { nome: 'Aniversário', image: 'https://firebasestorage.googleapis.com/v0/b/arte-festiva-atelie.firebasestorage.app/o/iconeaniversario.png?alt=media&token=cc6e1ab7-4603-4719-b959-c99a1d3c33c0' },
    { nome: 'Suportes e Boleiras', image: 'https://firebasestorage.googleapis.com/v0/b/arte-festiva-atelie.firebasestorage.app/o/iconetopobolo.png?alt=media&token=19d41856-ef04-4d50-811d-f7053ef1932a' },
    //{ nome: 'Velas e Topos', image: 'https://firebasestorage.googleapis.com/v0/b/arte-festiva-atelie.firebasestorage.app/o/iconetopobolo.png?alt=media&token=19d41856-ef04-4d50-811d-f7053ef1932a' }
  ];

  currentSlideIndex: number = 0;
  autoPlaySubscription?: Subscription;
  bannersLength: number = 0;
  suporteViaHistory = false;

  @HostListener('window:popstate', ['$event'])
  onPopState(event: any) {
    if (this.suporteEmDestaque) {
      this.suporteEmDestaque = null;
      this.suporteViaHistory = false;
    }
  }

  ngOnInit() {
    this.carregarBolos();
    this.carregarBanners();
    
    // Filtra os suportes diretamente do acervo principal para a vitrine separada
    this.suportes$ = this.bolosExibidos$.pipe(
      map(bolos => bolos.filter(b => 
        Array.isArray(b.categoria) ? b.categoria.includes('Suportes e Boleiras') : b.categoria === 'Suportes e Boleiras'
      ))
    );
    
    this.startAutoPlay();
  }

  ngOnDestroy() {
    this.stopAutoPlay();
  }

  carregarBolos() {
    this.bolosExibidos$ = this.boloService.getBolos();
  }

  carregarBanners() {
    this.banners$ = this.boloService.getBanners();
    this.banners$.subscribe(res => this.bannersLength = res.length);
  }

  filtrar(categoria: string) {
    this.categoriaAtiva = categoria;
    if (categoria === 'Todos') {
      this.carregarBolos();
    } else {
      this.bolosExibidos$ = this.boloService.getBolos().pipe(
        map((bolos: Bolo[]) => bolos.filter(b => 
          Array.isArray(b.categoria) ? b.categoria.includes(categoria) : b.categoria === categoria
        ))
      );
    }
  }

  startAutoPlay() {
    this.stopAutoPlay();
    this.autoPlaySubscription = interval(5000).subscribe(() => this.nextSlide());
  }

  stopAutoPlay() {
    this.autoPlaySubscription?.unsubscribe();
  }

  nextSlide() {
    if (this.bannersLength > 0) {
      this.currentSlideIndex = (this.currentSlideIndex + 1) % this.bannersLength;
    }
  }

  prevSlide() {
    if (this.bannersLength > 0) {
      this.currentSlideIndex = (this.currentSlideIndex - 1 + this.bannersLength) % this.bannersLength;
      this.startAutoPlay();
    }
  }

  setSlide(index: number) {
    this.currentSlideIndex = index;
    this.startAutoPlay();
  }

  abrirFotoSuporte(suporte: any) {
    this.suporteEmDestaque = suporte;
    history.pushState({ modal: 'suporte-home' }, '');
    this.suporteViaHistory = true;
  }

  fecharFotoSuporte() {
    this.suporteEmDestaque = null;
    if (this.suporteViaHistory) {
      this.suporteViaHistory = false;
      history.back();
    }
  }

  // Delega o acesso ao roteador, que será interceptado de forma blindada pelo CanActivate Guard das rotas
  acessarAdminSecreto() {
    this.router.navigate(['/admin-festiva-secreto']);
  }
}
