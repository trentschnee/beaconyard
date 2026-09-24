import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  type OnInit,
} from '@angular/core';
import { DashboardConnection } from './dashboard-connection';
import { DevicesStore } from './devices-store';

@Component({
  selector: 'app-devices-page',
  imports: [DatePipe],
  providers: [DevicesStore, DashboardConnection],
  templateUrl: './devices-page.html',
  styleUrl: './devices-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DevicesPage implements OnInit {
  private readonly connection = inject(DashboardConnection);

  protected readonly devices = inject(DevicesStore).rows;
  protected readonly status = this.connection.status;

  ngOnInit(): void {
    this.connection.start();
  }
}
