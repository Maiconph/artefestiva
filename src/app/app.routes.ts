import { Routes } from '@angular/router';
import { HomeComponent } from './home/home';
import { AdminComponent } from './admin/admin';
import { BoloDetalheComponent } from './bolo-detalhe/bolo-detalhe';
import { OrcamentoComponent } from './orcamento/orcamento';
import { AssinaturaUI } from './assinatura/assinatura';

import { inject } from '@angular/core';
import { Router } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    component: HomeComponent
  },
  {
    path: 'admin-festiva-secreto',
    component: AdminComponent,
    canActivate: [
      () => {
        const router = inject(Router);

        // 1. Token de Sessão Ativo: Se já passou pela validação nesta aba do navegador, entra direto
        if (sessionStorage.getItem('admin_autenticado') === 'true') {
          return true;
        }

        // 2. Bloqueio de Link Direto: Se tentou burlar digitando a URL, o porteiro intercepta e exige a senha
        const senha = prompt('Acesso Restrito. Digite a senha master do painel:');
        
        if (senha === 'festiva2026') {
          sessionStorage.setItem('admin_autenticado', 'true'); // Cria a chave de persistência de sessão
          return true;
        }

        // 3. Senha Incorreta ou Prompt Cancelado: Barra a renderização e chuta o usuário de volta pra Home
        alert('Senha incorreta! Acesso estritamente negado.');
        router.navigate(['/']);
        return false;
      }
    ]
  },
  {
    path: 'bolo/:id',
    component: BoloDetalheComponent
  },
  {
    path: 'orcamento',
    component: OrcamentoComponent
  },
  {
    path: 'assinatura/:id',
    component: AssinaturaUI
  },
  {
    path: 'minhas-reservas',
    loadComponent: () => import('./minhas-reservas/minhas-reservas').then(m => m.MinhasReservasClass)
  },
  {
    path: 'checkout/:id',
    loadComponent: () => import('./checkout/checkout').then(m => m.CheckoutView)
  }
];
