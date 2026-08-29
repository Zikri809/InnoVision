export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      ai_generation_usage: {
        Row: {
          count: number
          day: string
          user_id: string
        }
        Insert: {
          count?: number
          day?: string
          user_id: string
        }
        Update: {
          count?: number
          day?: string
          user_id?: string
        }
        Relationships: []
      }
      audit_events: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          id: string
          metadata: Json | null
          subject_id: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          subject_id: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          subject_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      class_enrollments: {
        Row: {
          class_id: string
          enrolled_at: string
          student_id: string
        }
        Insert: {
          class_id: string
          enrolled_at?: string
          student_id: string
        }
        Update: {
          class_id?: string
          enrolled_at?: string
          student_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "class_enrollments_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "class_enrollments_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "student_class_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "class_enrollments_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      class_join_attempts: {
        Row: {
          fail_count: number
          locked_until: string | null
          student_id: string
          window_started_at: string
        }
        Insert: {
          fail_count?: number
          locked_until?: string | null
          student_id: string
          window_started_at?: string
        }
        Update: {
          fail_count?: number
          locked_until?: string | null
          student_id?: string
          window_started_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "class_join_attempts_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      classes: {
        Row: {
          archived_at: string | null
          created_at: string
          id: string
          join_code: string
          lecturer_id: string
          title: string
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          id?: string
          join_code: string
          lecturer_id: string
          title: string
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          id?: string
          join_code?: string
          lecturer_id?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "classes_lecturer_id_fkey"
            columns: ["lecturer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      face_checks: {
        Row: {
          checked_at: string
          distance: number | null
          frame_hash: string | null
          id: string
          matched: boolean
          session_id: string
          suspected_replay: boolean
          too_frequent: boolean
          trigger: Database["public"]["Enums"]["face_check_trigger"]
        }
        Insert: {
          checked_at?: string
          distance?: number | null
          frame_hash?: string | null
          id?: string
          matched: boolean
          session_id: string
          suspected_replay?: boolean
          too_frequent?: boolean
          trigger: Database["public"]["Enums"]["face_check_trigger"]
        }
        Update: {
          checked_at?: string
          distance?: number | null
          frame_hash?: string | null
          id?: string
          matched?: boolean
          session_id?: string
          suspected_replay?: boolean
          too_frequent?: boolean
          trigger?: Database["public"]["Enums"]["face_check_trigger"]
        }
        Relationships: [
          {
            foreignKeyName: "face_checks_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "lecturer_session_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "face_checks_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "quiz_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "face_checks_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "student_session_view"
            referencedColumns: ["id"]
          },
        ]
      }
      incident_clips: {
        Row: {
          duration_ms: number
          id: string
          reason: string
          recorded_from: string
          recorded_to: string
          session_id: string
          storage_path: string
        }
        Insert: {
          duration_ms?: number
          id?: string
          reason: string
          recorded_from?: string
          recorded_to?: string
          session_id: string
          storage_path: string
        }
        Update: {
          duration_ms?: number
          id?: string
          reason?: string
          recorded_from?: string
          recorded_to?: string
          session_id?: string
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "incident_clips_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "lecturer_session_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incident_clips_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "quiz_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incident_clips_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "student_session_view"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          created_at: string
          dedupe_key: string
          id: string
          payload: Json
          read_at: string | null
          recipient_id: string
          seq: number
          type: Database["public"]["Enums"]["notification_type"]
        }
        Insert: {
          created_at?: string
          dedupe_key: string
          id?: string
          payload?: Json
          read_at?: string | null
          recipient_id: string
          seq?: never
          type: Database["public"]["Enums"]["notification_type"]
        }
        Update: {
          created_at?: string
          dedupe_key?: string
          id?: string
          payload?: Json
          read_at?: string | null
          recipient_id?: string
          seq?: never
          type?: Database["public"]["Enums"]["notification_type"]
        }
        Relationships: [
          {
            foreignKeyName: "notifications_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_path: string | null
          consent_given_at: string | null
          created_at: string
          face_deletion_pending: boolean
          face_enrollment_status: string | null
          full_name: string | null
          id: string
          locale: string
          matric_no: string | null
          role: Database["public"]["Enums"]["user_role"]
        }
        Insert: {
          avatar_path?: string | null
          consent_given_at?: string | null
          created_at?: string
          face_deletion_pending?: boolean
          face_enrollment_status?: string | null
          full_name?: string | null
          id: string
          locale?: string
          matric_no?: string | null
          role: Database["public"]["Enums"]["user_role"]
        }
        Update: {
          avatar_path?: string | null
          consent_given_at?: string | null
          created_at?: string
          face_deletion_pending?: boolean
          face_enrollment_status?: string | null
          full_name?: string | null
          id?: string
          locale?: string
          matric_no?: string | null
          role?: Database["public"]["Enums"]["user_role"]
        }
        Relationships: []
      }
      questions: {
        Row: {
          correct_index: number
          created_at: string
          explanation: string | null
          id: string
          image_path: string | null
          options: string[]
          order_index: number
          prompt: string
          quiz_id: string
          type: Database["public"]["Enums"]["question_type"]
        }
        Insert: {
          correct_index: number
          created_at?: string
          explanation?: string | null
          id?: string
          image_path?: string | null
          options: string[]
          order_index: number
          prompt: string
          quiz_id: string
          type: Database["public"]["Enums"]["question_type"]
        }
        Update: {
          correct_index?: number
          created_at?: string
          explanation?: string | null
          id?: string
          image_path?: string | null
          options?: string[]
          order_index?: number
          prompt?: string
          quiz_id?: string
          type?: Database["public"]["Enums"]["question_type"]
        }
        Relationships: [
          {
            foreignKeyName: "questions_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "quizzes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questions_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "student_closed_revealed_quiz_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questions_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "student_quiz_view"
            referencedColumns: ["id"]
          },
        ]
      }
      quiz_sessions: {
        Row: {
          attempt: number
          face_exempt: boolean
          face_fail_streak: number
          face_unavailable_at: string | null
          focus_pause_count: number
          id: string
          last_activity_at: string
          mode: Database["public"]["Enums"]["quiz_mode"]
          paused_at: string | null
          quiz_id: string
          score: number | null
          started_at: string
          status: Database["public"]["Enums"]["session_status"]
          student_id: string
          submitted_at: string | null
          verify_nonce: string
        }
        Insert: {
          attempt?: number
          face_exempt?: boolean
          face_fail_streak?: number
          face_unavailable_at?: string | null
          focus_pause_count?: number
          id?: string
          last_activity_at?: string
          mode: Database["public"]["Enums"]["quiz_mode"]
          paused_at?: string | null
          quiz_id: string
          score?: number | null
          started_at?: string
          status?: Database["public"]["Enums"]["session_status"]
          student_id: string
          submitted_at?: string | null
          verify_nonce?: string
        }
        Update: {
          attempt?: number
          face_exempt?: boolean
          face_fail_streak?: number
          face_unavailable_at?: string | null
          focus_pause_count?: number
          id?: string
          last_activity_at?: string
          mode?: Database["public"]["Enums"]["quiz_mode"]
          paused_at?: string | null
          quiz_id?: string
          score?: number | null
          started_at?: string
          status?: Database["public"]["Enums"]["session_status"]
          student_id?: string
          submitted_at?: string | null
          verify_nonce?: string
        }
        Relationships: [
          {
            foreignKeyName: "quiz_sessions_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "quizzes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_sessions_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "student_closed_revealed_quiz_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_sessions_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "student_quiz_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_sessions_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      quizzes: {
        Row: {
          allow_retake: boolean
          auto_reveal_on_complete: boolean
          class_id: string
          closes_at: string | null
          created_at: string
          created_by: string
          id: string
          max_attempts: number
          mode: Database["public"]["Enums"]["quiz_mode"]
          opens_at: string | null
          results_revealed_at: string | null
          source_file_url: string | null
          source_text: string | null
          sources: Json
          status: Database["public"]["Enums"]["quiz_status"]
          time_limit_sec: number | null
          title: string
        }
        Insert: {
          allow_retake?: boolean
          auto_reveal_on_complete?: boolean
          class_id: string
          closes_at?: string | null
          created_at?: string
          created_by: string
          id?: string
          max_attempts?: number
          mode?: Database["public"]["Enums"]["quiz_mode"]
          opens_at?: string | null
          results_revealed_at?: string | null
          source_file_url?: string | null
          source_text?: string | null
          sources?: Json
          status?: Database["public"]["Enums"]["quiz_status"]
          time_limit_sec?: number | null
          title: string
        }
        Update: {
          allow_retake?: boolean
          auto_reveal_on_complete?: boolean
          class_id?: string
          closes_at?: string | null
          created_at?: string
          created_by?: string
          id?: string
          max_attempts?: number
          mode?: Database["public"]["Enums"]["quiz_mode"]
          opens_at?: string | null
          results_revealed_at?: string | null
          source_file_url?: string | null
          source_text?: string | null
          sources?: Json
          status?: Database["public"]["Enums"]["quiz_status"]
          time_limit_sec?: number | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "quizzes_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quizzes_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "student_class_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quizzes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      session_advisories: {
        Row: {
          adv_type: string
          first_seen_at: string
          id: string
          last_seen_at: string
          occurrences: number
          session_id: string
        }
        Insert: {
          adv_type: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          occurrences?: number
          session_id: string
        }
        Update: {
          adv_type?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          occurrences?: number
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_advisories_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "lecturer_session_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_advisories_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "quiz_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_advisories_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "student_session_view"
            referencedColumns: ["id"]
          },
        ]
      }
      session_answers: {
        Row: {
          answered_at: string
          id: string
          is_correct: boolean
          question_id: string
          selected_index: number | null
          session_id: string
        }
        Insert: {
          answered_at?: string
          id?: string
          is_correct: boolean
          question_id: string
          selected_index?: number | null
          session_id: string
        }
        Update: {
          answered_at?: string
          id?: string
          is_correct?: boolean
          question_id?: string
          selected_index?: number | null
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "student_question_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_answers_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "lecturer_session_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_answers_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "quiz_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_answers_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "student_session_view"
            referencedColumns: ["id"]
          },
        ]
      }
      student_quiz_questions: {
        Row: {
          correct_index: number
          created_at: string
          explanation: string | null
          id: string
          image_path: string | null
          options: string[]
          order_index: number
          prompt: string
          quiz_id: string
          type: Database["public"]["Enums"]["question_type"]
        }
        Insert: {
          correct_index: number
          created_at?: string
          explanation?: string | null
          id?: string
          image_path?: string | null
          options: string[]
          order_index: number
          prompt: string
          quiz_id: string
          type: Database["public"]["Enums"]["question_type"]
        }
        Update: {
          correct_index?: number
          created_at?: string
          explanation?: string | null
          id?: string
          image_path?: string | null
          options?: string[]
          order_index?: number
          prompt?: string
          quiz_id?: string
          type?: Database["public"]["Enums"]["question_type"]
        }
        Relationships: [
          {
            foreignKeyName: "student_quiz_questions_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "student_quizzes"
            referencedColumns: ["id"]
          },
        ]
      }
      student_quizzes: {
        Row: {
          created_at: string
          created_by: string
          description: string | null
          id: string
          share_code: string | null
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          description?: string | null
          id?: string
          share_code?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          description?: string | null
          id?: string
          share_code?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "student_quizzes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      lecturer_answers_view: {
        Row: {
          answered_at: string | null
          id: string | null
          is_correct: boolean | null
          question_id: string | null
          selected_index: number | null
          session_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "session_answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "student_question_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_answers_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "lecturer_session_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_answers_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "quiz_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_answers_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "student_session_view"
            referencedColumns: ["id"]
          },
        ]
      }
      lecturer_audit_view: {
        Row: {
          action: string | null
          actor_id: string | null
          created_at: string | null
          event_quiz_id: string | null
          event_session_id: string | null
          id: string | null
          subject_id: string | null
        }
        Insert: {
          action?: string | null
          actor_id?: string | null
          created_at?: string | null
          event_quiz_id?: never
          event_session_id?: never
          id?: string | null
          subject_id?: string | null
        }
        Update: {
          action?: string | null
          actor_id?: string | null
          created_at?: string | null
          event_quiz_id?: never
          event_session_id?: never
          id?: string | null
          subject_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      lecturer_session_view: {
        Row: {
          attempt: number | null
          face_exempt: boolean | null
          face_fail_streak: number | null
          face_unavailable_at: string | null
          focus_pause_count: number | null
          id: string | null
          last_activity_at: string | null
          mode: Database["public"]["Enums"]["quiz_mode"] | null
          quiz_id: string | null
          score: number | null
          started_at: string | null
          status: Database["public"]["Enums"]["session_status"] | null
          student_id: string | null
          submitted_at: string | null
        }
        Insert: {
          attempt?: number | null
          face_exempt?: boolean | null
          face_fail_streak?: number | null
          face_unavailable_at?: string | null
          focus_pause_count?: number | null
          id?: string | null
          last_activity_at?: string | null
          mode?: Database["public"]["Enums"]["quiz_mode"] | null
          quiz_id?: string | null
          score?: number | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["session_status"] | null
          student_id?: string | null
          submitted_at?: string | null
        }
        Update: {
          attempt?: number | null
          face_exempt?: boolean | null
          face_fail_streak?: number | null
          face_unavailable_at?: string | null
          focus_pause_count?: number | null
          id?: string | null
          last_activity_at?: string | null
          mode?: Database["public"]["Enums"]["quiz_mode"] | null
          quiz_id?: string | null
          score?: number | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["session_status"] | null
          student_id?: string | null
          submitted_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "quiz_sessions_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "quizzes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_sessions_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "student_closed_revealed_quiz_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_sessions_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "student_quiz_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_sessions_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      student_answers_view: {
        Row: {
          answered_at: string | null
          id: string | null
          is_correct: boolean | null
          question_id: string | null
          selected_index: number | null
          session_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "session_answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "student_question_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_answers_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "lecturer_session_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_answers_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "quiz_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_answers_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "student_session_view"
            referencedColumns: ["id"]
          },
        ]
      }
      student_class_view: {
        Row: {
          created_at: string | null
          id: string | null
          title: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string | null
          title?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string | null
          title?: string | null
        }
        Relationships: []
      }
      student_closed_revealed_quiz_view: {
        Row: {
          class_id: string | null
          closes_at: string | null
          created_at: string | null
          id: string | null
          mode: Database["public"]["Enums"]["quiz_mode"] | null
          opens_at: string | null
          results_revealed_at: string | null
          status: Database["public"]["Enums"]["quiz_status"] | null
          time_limit_sec: number | null
          title: string | null
        }
        Relationships: [
          {
            foreignKeyName: "quizzes_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quizzes_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "student_class_view"
            referencedColumns: ["id"]
          },
        ]
      }
      student_question_view: {
        Row: {
          created_at: string | null
          has_image: boolean | null
          id: string | null
          options: string[] | null
          order_index: number | null
          prompt: string | null
          quiz_id: string | null
          type: Database["public"]["Enums"]["question_type"] | null
        }
        Insert: {
          created_at?: string | null
          has_image?: never
          id?: string | null
          options?: string[] | null
          order_index?: number | null
          prompt?: string | null
          quiz_id?: string | null
          type?: Database["public"]["Enums"]["question_type"] | null
        }
        Update: {
          created_at?: string | null
          has_image?: never
          id?: string | null
          options?: string[] | null
          order_index?: number | null
          prompt?: string | null
          quiz_id?: string | null
          type?: Database["public"]["Enums"]["question_type"] | null
        }
        Relationships: [
          {
            foreignKeyName: "questions_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "quizzes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questions_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "student_closed_revealed_quiz_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questions_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "student_quiz_view"
            referencedColumns: ["id"]
          },
        ]
      }
      student_quiz_player_question_view: {
        Row: {
          created_at: string | null
          has_image: boolean | null
          id: string | null
          options: string[] | null
          order_index: number | null
          prompt: string | null
          quiz_id: string | null
          type: Database["public"]["Enums"]["question_type"] | null
        }
        Insert: {
          created_at?: string | null
          has_image?: never
          id?: string | null
          options?: string[] | null
          order_index?: number | null
          prompt?: string | null
          quiz_id?: string | null
          type?: Database["public"]["Enums"]["question_type"] | null
        }
        Update: {
          created_at?: string | null
          has_image?: never
          id?: string | null
          options?: string[] | null
          order_index?: number | null
          prompt?: string | null
          quiz_id?: string | null
          type?: Database["public"]["Enums"]["question_type"] | null
        }
        Relationships: [
          {
            foreignKeyName: "student_quiz_questions_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "student_quizzes"
            referencedColumns: ["id"]
          },
        ]
      }
      student_quiz_view: {
        Row: {
          allow_retake: boolean | null
          class_id: string | null
          closes_at: string | null
          created_at: string | null
          id: string | null
          max_attempts: number | null
          mode: Database["public"]["Enums"]["quiz_mode"] | null
          opens_at: string | null
          results_revealed_at: string | null
          status: Database["public"]["Enums"]["quiz_status"] | null
          time_limit_sec: number | null
          title: string | null
        }
        Relationships: [
          {
            foreignKeyName: "quizzes_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quizzes_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "student_class_view"
            referencedColumns: ["id"]
          },
        ]
      }
      student_roster_view: {
        Row: {
          class_id: string | null
          enrolled_at: string | null
          full_name: string | null
          matric_no: string | null
          student_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "class_enrollments_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "class_enrollments_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "student_class_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "class_enrollments_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      student_session_view: {
        Row: {
          attempt: number | null
          face_exempt: boolean | null
          face_fail_streak: number | null
          face_unavailable_at: string | null
          id: string | null
          last_activity_at: string | null
          mode: Database["public"]["Enums"]["quiz_mode"] | null
          quiz_id: string | null
          score: number | null
          started_at: string | null
          status: Database["public"]["Enums"]["session_status"] | null
          student_id: string | null
          submitted_at: string | null
          verify_nonce: string | null
        }
        Insert: {
          attempt?: number | null
          face_exempt?: boolean | null
          face_fail_streak?: number | null
          face_unavailable_at?: string | null
          id?: string | null
          last_activity_at?: string | null
          mode?: Database["public"]["Enums"]["quiz_mode"] | null
          quiz_id?: string | null
          score?: never
          started_at?: string | null
          status?: Database["public"]["Enums"]["session_status"] | null
          student_id?: string | null
          submitted_at?: string | null
          verify_nonce?: string | null
        }
        Update: {
          attempt?: number | null
          face_exempt?: boolean | null
          face_fail_streak?: number | null
          face_unavailable_at?: string | null
          id?: string | null
          last_activity_at?: string | null
          mode?: Database["public"]["Enums"]["quiz_mode"] | null
          quiz_id?: string | null
          score?: never
          started_at?: string | null
          status?: Database["public"]["Enums"]["session_status"] | null
          student_id?: string | null
          submitted_at?: string | null
          verify_nonce?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "quiz_sessions_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "quizzes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_sessions_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "student_closed_revealed_quiz_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_sessions_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "student_quiz_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_sessions_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      answer_question: {
        Args: {
          p_question_id: string
          p_selected_index: number
          p_session_id: string
        }
        Returns: Json
      }
      answer_student_question: {
        Args: { p_question_id: string; p_selected_index: number }
        Returns: Json
      }
      append_question: {
        Args: {
          p_correct_index: number
          p_explanation: string
          p_options: string[]
          p_prompt: string
          p_quiz_id: string
          p_type: Database["public"]["Enums"]["question_type"]
        }
        Returns: {
          correct_index: number
          created_at: string
          explanation: string | null
          id: string
          image_path: string | null
          options: string[]
          order_index: number
          prompt: string
          quiz_id: string
          type: Database["public"]["Enums"]["question_type"]
        }
        SetofOptions: {
          from: "*"
          to: "questions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      append_student_question: {
        Args: {
          p_correct_index: number
          p_explanation: string
          p_options: string[]
          p_prompt: string
          p_quiz_id: string
          p_type: Database["public"]["Enums"]["question_type"]
        }
        Returns: {
          correct_index: number
          created_at: string
          explanation: string | null
          id: string
          image_path: string | null
          options: string[]
          order_index: number
          prompt: string
          quiz_id: string
          type: Database["public"]["Enums"]["question_type"]
        }
        SetofOptions: {
          from: "*"
          to: "student_quiz_questions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      backfill_notification_state: { Args: never; Returns: Json }
      can_student_view_quiz: { Args: { p_quiz_id: string }; Returns: boolean }
      confirm_face_subject_deleted: { Args: never; Returns: Json }
      enroll_face: {
        Args: { p_duplicate_similarity: number; p_duplicate_subject: string }
        Returns: Json
      }
      exempt_face_session: {
        Args: { p_reason: string; p_session_id: string }
        Returns: Json
      }
      grant_face_consent: { Args: never; Returns: Json }
      is_enrolled_in_class: { Args: { p_class_id: string }; Returns: boolean }
      is_lecturer: { Args: never; Returns: boolean }
      is_lecturer_of_class: { Args: { p_class_id: string }; Returns: boolean }
      is_lecturer_of_quiz: { Args: { p_quiz_id: string }; Returns: boolean }
      is_session_owner_or_lecturer: {
        Args: { p_session_id: string }
        Returns: boolean
      }
      is_shared_student_quiz: { Args: { p_quiz_id: string }; Returns: boolean }
      is_student: { Args: never; Returns: boolean }
      is_student_quiz_creator: { Args: { p_quiz_id: string }; Returns: boolean }
      is_student_reveal_allowed: {
        Args: { p_quiz_id: string }
        Returns: boolean
      }
      join_class: { Args: { code: string }; Returns: Json }
      mark_notifications_read: { Args: { p_ids: string[] }; Returns: Json }
      mark_notifications_read_before: { Args: { p_seq: number }; Returns: Json }
      pause_session: {
        Args: { p_reason?: string; p_session_id: string }
        Returns: Json
      }
      prune_expired_data: { Args: never; Returns: Json }
      prune_expired_incident_clips: { Args: never; Returns: Json }
      prune_expired_notifications: { Args: never; Returns: Json }
      quiz_autoclose: { Args: never; Returns: number }
      record_face_check: {
        Args: {
          p_frames: string[]
          p_nonce: string
          p_session_id: string
          p_similarities: number[]
          p_subject: string
          p_trigger: Database["public"]["Enums"]["face_check_trigger"]
        }
        Returns: Json
      }
      reject_face_enrollment: { Args: { p_student_id: string }; Returns: Json }
      reorder_questions: {
        Args: { p_ordered_ids: string[]; p_quiz_id: string }
        Returns: undefined
      }
      reorder_student_questions: {
        Args: { p_ordered_ids: string[]; p_quiz_id: string }
        Returns: undefined
      }
      report_face_unavailable: { Args: { p_session_id: string }; Returns: Json }
      report_session_advisory: {
        Args: { p_session_id: string; p_type: string }
        Returns: Json
      }
      reset_session: { Args: { p_session_id: string }; Returns: Json }
      resolve_question_image: {
        Args: { p_question_id: string }
        Returns: {
          image_path: string
          ttl_seconds: number
        }[]
      }
      resolve_shared_student_quiz: { Args: { p_code: string }; Returns: Json }
      revoke_face_consent: { Args: never; Returns: Json }
      safe_audit_uuid: { Args: { p_value: string }; Returns: string }
      save_quiz_questions: {
        Args: {
          p_mode?: string
          p_questions: Json
          p_quiz_id: string
          p_source_file_url: string
          p_source_text: string
          p_title: string
        }
        Returns: undefined
      }
      save_student_quiz_questions: {
        Args: { p_mode?: string; p_questions: Json; p_quiz_id: string }
        Returns: {
          correct_index: number
          created_at: string
          explanation: string | null
          id: string
          image_path: string | null
          options: string[]
          order_index: number
          prompt: string
          quiz_id: string
          type: Database["public"]["Enums"]["question_type"]
        }[]
        SetofOptions: {
          from: "*"
          to: "student_quiz_questions"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      self_recover_session: { Args: { p_session_id: string }; Returns: Json }
      start_quiz_session: { Args: { p_quiz_id: string }; Returns: Json }
      student_quiz_share_action: {
        Args: { p_action: string; p_code?: string; p_quiz_id: string }
        Returns: Json
      }
      student_results: { Args: { p_quiz_id: string }; Returns: Json }
      submit_session: { Args: { p_session_id: string }; Returns: Json }
      unlock_session: { Args: { p_session_id: string }; Returns: Json }
    }
    Enums: {
      face_check_trigger: "start" | "question" | "periodic"
      notification_type:
        | "quiz_live"
        | "results_revealed"
        | "session_reset"
        | "removed_from_class"
        | "class_archived"
        | "student_joined"
        | "session_submitted"
        | "session_flagged"
        | "quiz_completed_all"
        | "incident_clip_recorded"
        | "face_unavailable_reported"
        | "face_enrollment_held"
        | "quiz_closed"
        | "session_unlocked"
      question_type: "mcq" | "true_false"
      quiz_mode: "practice" | "assessment"
      quiz_status: "draft" | "live" | "closed"
      session_status: "active" | "paused" | "flagged" | "completed"
      user_role: "lecturer" | "student"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      face_check_trigger: ["start", "question", "periodic"],
      notification_type: [
        "quiz_live",
        "results_revealed",
        "session_reset",
        "removed_from_class",
        "class_archived",
        "student_joined",
        "session_submitted",
        "session_flagged",
        "quiz_completed_all",
        "incident_clip_recorded",
        "face_unavailable_reported",
        "face_enrollment_held",
        "quiz_closed",
        "session_unlocked",
      ],
      question_type: ["mcq", "true_false"],
      quiz_mode: ["practice", "assessment"],
      quiz_status: ["draft", "live", "closed"],
      session_status: ["active", "paused", "flagged", "completed"],
      user_role: ["lecturer", "student"],
    },
  },
} as const
