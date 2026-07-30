import { useState } from 'react';
import { validateTopicBasic, validateTopicWithNetwork, type ValidationResult } from '@/lib/topicValidation';

export function useTopicValidation() {
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [isValidating, setIsValidating] = useState(false);

  const validateBasic = (title: string, website: string): ValidationResult => {
    const result = validateTopicBasic(title, website);
    setValidationResult(result);
    return result;
  };

  const validateWithNetwork = async (title: string, website: string): Promise<ValidationResult> => {
    setIsValidating(true);
    try {
      const result = await validateTopicWithNetwork(title, website);
      setValidationResult(result);
      return result;
    } finally {
      setIsValidating(false);
    }
  };

  const clearValidation = () => {
    setValidationResult(null);
  };

  return {
    validationResult,
    isValidating,
    validateBasic,
    validateWithNetwork,
    clearValidation,
  };
}
