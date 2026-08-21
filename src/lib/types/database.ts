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
      classes: {
        Row: {
          created_at: string
          id: string
          join_code: string
          lecturer_id: string
          title: string
        }
        Insert: {
          created_at?: string
          id?: string
          join_code: string
          lecturer_id: string
          title: string
        }
        Update: {
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
      profiles: {
        Row: {
          consent_given_at: string | null
          created_at: string
          face_deletion_pending: boolean
          face_enrollment_status: string | null
          full_name: string | null
          id: string
          locale: string
          role: Database["public"]["Enums"]["user_role"]
        }
        Insert: {
          consent_given_at?: string | null
          created_at?: string
          face_deletion_pending?: boolean
          face_enrollment_status?: string | null
          full_name?: string | null
          id: string
          locale?: string
          role: Database["public"]["Enums"]["user_role"]
        }
        Update: {
          consent_given_at?: string | null
          created_at?: string
          face_deletion_pending?: boolean
          face_enrollment_status?: string | null
          full_name?: string | null
          id?: string
          locale?: string
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
            referencedRelation: "student_quiz_view"
            referencedColumns: ["id"]
          },
        ]
      }
      quiz_sessions: {
        Row: {
          face_exempt: boolean
          face_fail_streak: number
          face_unavailable_at: string | null
          id: string
          last_activity_at: string
          mode: Database["public"]["Enums"]["quiz_mode"]
          quiz_id: string
          score: number | null
          started_at: string
          status: Database["public"]["Enums"]["session_status"]
          student_id: string
          submitted_at: string | null
          verify_nonce: string
        }
        Insert: {
          face_exempt?: boolean
          face_fail_streak?: number
          face_unavailable_at?: string | null
          id?: string
          last_activity_at?: string
          mode: Database["public"]["Enums"]["quiz_mode"]
          quiz_id: string
          score?: number | null
          started_at?: string
          status?: Database["public"]["Enums"]["session_status"]
          student_id: string
          submitted_at?: string | null
          verify_nonce?: string
        }
        Update: {
          face_exempt?: boolean
          face_fail_streak?: number
          face_unavailable_at?: string | null
          id?: string
          last_activity_at?: string
          mode?: Database["public"]["Enums"]["quiz_mode"]
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
          auto_reveal_on_complete: boolean
          class_id: string
          created_at: string
          created_by: string
          id: string
          mode: Database["public"]["Enums"]["quiz_mode"]
          results_revealed_at: string | null
          source_file_url: string | null
          source_text: string | null
          sources: Json
          status: Database["public"]["Enums"]["quiz_status"]
          time_limit_sec: number | null
          title: string
        }
        Insert: {
          auto_reveal_on_complete?: boolean
          class_id: string
          created_at?: string
          created_by: string
          id?: string
          mode?: Database["public"]["Enums"]["quiz_mode"]
          results_revealed_at?: string | null
          source_file_url?: string | null
          source_text?: string | null
          sources?: Json
          status?: Database["public"]["Enums"]["quiz_status"]
          time_limit_sec?: number | null
          title: string
        }
        Update: {
          auto_reveal_on_complete?: boolean
          class_id?: string
          created_at?: string
          created_by?: string
          id?: string
          mode?: Database["public"]["Enums"]["quiz_mode"]
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
        }
        Insert: {
          face_exempt?: boolean | null
          face_fail_streak?: number | null
          face_unavailable_at?: string | null
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
          face_exempt?: boolean | null
          face_fail_streak?: number | null
          face_unavailable_at?: string | null
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
      student_question_view: {
        Row: {
          created_at: string | null
          id: string | null
          options: string[] | null
          order_index: number | null
          prompt: string | null
          quiz_id: string | null
          type: Database["public"]["Enums"]["question_type"] | null
        }
        Insert: {
          created_at?: string | null
          id?: string | null
          options?: string[] | null
          order_index?: number | null
          prompt?: string | null
          quiz_id?: string | null
          type?: Database["public"]["Enums"]["question_type"] | null
        }
        Update: {
          created_at?: string | null
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
            referencedRelation: "student_quiz_view"
            referencedColumns: ["id"]
          },
        ]
      }
      student_quiz_view: {
        Row: {
          class_id: string | null
          created_at: string | null
          id: string | null
          mode: Database["public"]["Enums"]["quiz_mode"] | null
          results_revealed_at: string | null
          status: Database["public"]["Enums"]["quiz_status"] | null
          time_limit_sec: number | null
          title: string | null
        }
        Insert: {
          class_id?: string | null
          created_at?: string | null
          id?: string | null
          mode?: Database["public"]["Enums"]["quiz_mode"] | null
          results_revealed_at?: string | null
          status?: Database["public"]["Enums"]["quiz_status"] | null
          time_limit_sec?: number | null
          title?: string | null
        }
        Update: {
          class_id?: string | null
          created_at?: string | null
          id?: string | null
          mode?: Database["public"]["Enums"]["quiz_mode"] | null
          results_revealed_at?: string | null
          status?: Database["public"]["Enums"]["quiz_status"] | null
          time_limit_sec?: number | null
          title?: string | null
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
      can_student_view_quiz: { Args: { p_quiz_id: string }; Returns: boolean }
      enroll_face: {
        Args: { p_duplicate_similarity: number; p_duplicate_subject: string }
        Returns: Json
      }
      exempt_face_session: {
        Args: { p_reason: string; p_session_id: string }
        Returns: Json
      }
      is_enrolled_in_class: { Args: { p_class_id: string }; Returns: boolean }
      is_lecturer: { Args: never; Returns: boolean }
      is_lecturer_of_class: { Args: { p_class_id: string }; Returns: boolean }
      is_lecturer_of_quiz: { Args: { p_quiz_id: string }; Returns: boolean }
      is_session_owner_or_lecturer: {
        Args: { p_session_id: string }
        Returns: boolean
      }
      is_student_reveal_allowed: {
        Args: { p_quiz_id: string }
        Returns: boolean
      }
      join_class: { Args: { code: string }; Returns: Json }
      pause_session: { Args: { p_session_id: string }; Returns: Json }
      record_face_check: {
        Args: {
          p_frame: string
          p_nonce: string
          p_second_similarity: number
          p_second_subject: string
          p_session_id: string
          p_similarity: number
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
      replace_quiz_questions: {
        Args: {
          p_questions: Json
          p_quiz_id: string
          p_source_file_url: string
          p_source_text: string
          p_title: string
        }
        Returns: {
          correct_index: number
          created_at: string
          explanation: string | null
          id: string
          options: string[]
          order_index: number
          prompt: string
          quiz_id: string
          type: Database["public"]["Enums"]["question_type"]
        }[]
        SetofOptions: {
          from: "*"
          to: "questions"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      save_quiz_questions: {
        Args: {
          p_mode?: string
          p_questions: Json
          p_quiz_id: string
          p_source_file_url?: string | null
          p_source_text?: string | null
          p_title?: string | null
        }
        Returns: {
          correct_index: number
          created_at: string
          explanation: string | null
          id: string
          options: string[]
          order_index: number
          prompt: string
          quiz_id: string
          type: Database["public"]["Enums"]["question_type"]
        }[]
        SetofOptions: {
          from: "*"
          to: "questions"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      report_face_unavailable: { Args: { p_session_id: string }; Returns: Json }
      reset_session: { Args: { p_session_id: string }; Returns: Json }
      revoke_face_consent: { Args: never; Returns: Json }
      safe_audit_uuid: { Args: { p_value: string }; Returns: string }
      self_recover_session: { Args: { p_session_id: string }; Returns: Json }
      start_quiz_session: { Args: { p_quiz_id: string }; Returns: Json }
      student_results: { Args: { p_quiz_id: string }; Returns: Json }
      submit_session: { Args: { p_session_id: string }; Returns: Json }
      unlock_session: { Args: { p_session_id: string }; Returns: Json }
    }
    Enums: {
      face_check_trigger: "start" | "question" | "periodic"
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
      question_type: ["mcq", "true_false"],
      quiz_mode: ["practice", "assessment"],
      quiz_status: ["draft", "live", "closed"],
      session_status: ["active", "paused", "flagged", "completed"],
      user_role: ["lecturer", "student"],
    },
  },
} as const
