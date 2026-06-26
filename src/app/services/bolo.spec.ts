import { TestBed } from '@angular/core/testing';

import { Bolo } from './bolo';

describe('Bolo', () => {
  let service: Bolo;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(Bolo);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
