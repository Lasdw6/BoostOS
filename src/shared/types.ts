// Activity event types for the collector
export interface ActivityContext {
  hour: number
  day_of_week: number
  is_weekend: boolean
  screen_count: number
  battery_percent: number
}

export interface ActivityEvent {
  timestamp: string
  event_type: 'app_focus' | 'app_session_end' | 'media_state_change' | 'system_idle_start'
  session_id: string
  data: Record<string, any>
  context: ActivityContext
}
