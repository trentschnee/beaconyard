import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { App } from './app';
import { appRoutes } from './app.routes';
import {
  DASHBOARD_SOCKET_FACTORY,
  type DashboardSocket,
} from './devices/dashboard-connection';

// a connection that never hears back
class SilentSocket extends EventTarget implements DashboardSocket {
  close() {
    // nothing to close
  }
}

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter(appRoutes),
        {
          provide: DASHBOARD_SOCKET_FACTORY,
          useValue: () => new SilentSocket(),
        },
      ],
    }).compileComponents();
  });

  it('shows the devices page at /', async () => {
    const fixture = TestBed.createComponent(App);
    await TestBed.inject(Router).navigateByUrl('/');
    await fixture.whenStable();

    const page = (fixture.nativeElement as HTMLElement).querySelector(
      'app-devices-page',
    );
    expect(page?.querySelector('h1')?.textContent).toContain('Devices');
    expect(page?.querySelector('[role="status"]')?.textContent?.trim()).toBe(
      'connecting',
    );
  });
});
