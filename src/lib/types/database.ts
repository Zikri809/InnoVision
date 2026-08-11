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
      profiles: {
        Row: {
          consent_given_at: string | null
          created_at: string
          face_embedding: string | null
          full_name: string | null
          id: string
          role: Database["public"]["Enums"]["user_role"]
        }
        Insert: {
          consent_given_at?: string | null
          created_at?: string
          face_embedding?: string | null
          full_name?: string | null
          id: string
          role: Database["public"]["Enums"]["user_role"]
        }
        Update: {
          consent_given_at?: string | null
          created_at?: string
          face_embedding?: string | null
          full_name?: string | null
          id?: string
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
      quizzes: {
        Row: {
          class_id: string
          created_at: string
          created_by: string
          id: string
          mode: Database["public"]["Enums"]["quiz_mode"]
          source_file_url: string | null
          source_text: string | null
          status: Database["public"]["Enums"]["quiz_status"]
          time_limit_sec: number | null
          title: string
        }
        Insert: {
          class_id: string
          created_at?: string
          created_by: string
          id?: string
          mode?: Database["public"]["Enums"]["quiz_mode"]
          source_file_url?: string | null
          source_text?: string | null
          status?: Database["public"]["Enums"]["quiz_status"]
          time_limit_sec?: number | null
          title: string
        }
        Update: {
          class_id?: string
          created_at?: string
          created_by?: string
          id?: string
          mode?: Database["public"]["Enums"]["quiz_mode"]
          source_file_url?: string | null
          source_text?: string | null
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
    }
    Views: {
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
      student_quiz_view: {
        Row: {
          class_id: string | null
          created_at: string | null
          id: string | null
          mode: Database["public"]["Enums"]["quiz_mode"] | null
          status: Database["public"]["Enums"]["quiz_status"] | null
          time_limit_sec: number | null
          title: string | null
        }
        Insert: {
          class_id?: string | null
          created_at?: string | null
          id?: string | null
          mode?: Database["public"]["Enums"]["quiz_mode"] | null
          status?: Database["public"]["Enums"]["quiz_status"] | null
          time_limit_sec?: number | null
          title?: string | null
        }
        Update: {
          class_id?: string | null
          created_at?: string | null
          id?: string | null
          mode?: Database["public"]["Enums"]["quiz_mode"] | null
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
    }
    Functions: {
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
      is_enrolled_in_class: { Args: { p_class_id: string }; Returns: boolean }
      is_lecturer: { Args: never; Returns: boolean }
      is_lecturer_of_class: { Args: { p_class_id: string }; Returns: boolean }
      is_lecturer_of_quiz: { Args: { p_quiz_id: string }; Returns: boolean }
      join_class: { Args: { code: string }; Returns: Json }
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
    }
    Enums: {
      question_type: "mcq" | "true_false"
      quiz_mode: "practice" | "assessment"
      quiz_status: "draft" | "live" | "closed"
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
      question_type: ["mcq", "true_false"],
      quiz_mode: ["practice", "assessment"],
      quiz_status: ["draft", "live", "closed"],
      user_role: ["lecturer", "student"],
    },
  },
} as const
